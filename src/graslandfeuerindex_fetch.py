#!/usr/bin/env python3
"""Independent read-only DWD GLFI fetcher for lhh-data-hub."""
from __future__ import annotations
import argparse
import csv
import gzip
import io
import json
import io
import os
import re
import tempfile
import urllib.error
import urllib.request
import zlib
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from zoneinfo import ZoneInfo

STATION_ID = "2627"
STATION_NAME = "Schipkau-Klettwitz"
SOURCE_URL = "https://opendata.dwd.de/climate_environment/CDC/derived_germany/fire_danger_index/grassland/forecast/recent/derived_germany_fire_danger_index_grassland_forecast_recent_2627_v2-0--0.csv.gz"
PROVIDER = "Deutscher Wetterdienst (DWD), CDC Open Data"
LICENSE = "CC BY 4.0"
FRESHNESS_HOURS = 36
MAX_RESPONSE_BYTES = 1_000_000
MAX_CSV_BYTES = 2_000_000
BERLIN = ZoneInfo("Europe/Berlin")

class SourceError(ValueError):
    """Safe, non-sensitive upstream or data-validation failure."""

def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def parse_dwd_timestamp(raw):
    try:
        value = datetime.strptime(raw.strip(), "%Y%m%d %H:%M").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise SourceError("DWD-Zeitstempel ungültig") from exc
    if value.strftime("%Y%m%d %H:%M") != raw.strip():
        raise SourceError("DWD-Zeitstempel ungültig")
    return value

def parse_forecast_csv(payload, station_id=STATION_ID):
    try:
        text = payload.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise SourceError("DWD-CSV-Encoding ungültig") from exc
    lines = [line for line in text.splitlines() if line.strip()]
    expected = ["StationsID", "Termin"] + ["glfi_%d" % n for n in range(7)]
    if len(lines) < 2:
        raise SourceError("DWD-CSV enthält keine Stationsdaten")
    try:
        header = next(csv.reader([lines[0]], delimiter=";"))
    except csv.Error as exc:
        raise SourceError("DWD-CSV-Kopf ungültig") from exc
    if [field.strip() for field in header] != expected:
        raise SourceError("DWD-CSV-Schema unerwartet")
    selected = []
    for line in lines[1:]:
        try:
            cells = next(csv.reader([line], delimiter=";"))
        except csv.Error as exc:
            raise SourceError("DWD-CSV-Zeile ungültig") from exc
        cells = [cell.strip() for cell in cells]
        if not cells or cells[0] != station_id:
            continue
        if len(cells) != len(expected):
            raise SourceError("DWD-CSV-Spaltenzahl unerwartet")
        issued = parse_dwd_timestamp(cells[1])
        if any(not re.fullmatch(r"[1-5]", value) for value in cells[2:]):
            raise SourceError("DWD-Indexwert außerhalb der Klassen 1 bis 5")
        selected.append((issued, [int(value) for value in cells[2:]]))
    if not selected:
        raise SourceError("DWD-Station 2627 fehlt in der CSV")
    selected.sort(key=lambda row: row[0])
    return selected[-1]

def valid_iso_timestamp(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        return False
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return parsed.tzinfo is not None

def validate_feed(feed):
    if not isinstance(feed, dict) or feed.get("schemaVersion") != 1:
        return False
    station = feed.get("station")
    source = feed.get("source")
    days = feed.get("days")
    if station != {"name": STATION_NAME, "id": STATION_ID}:
        return False
    if not isinstance(source, dict) or source.get("provider") != PROVIDER or source.get("url") != SOURCE_URL or source.get("productVersion") != "v2-0--0" or source.get("license") != LICENSE:
        return False
    if feed.get("status") not in ("ok", "stale", "error") or not isinstance(days, list):
        return False
    if feed["status"] == "error":
        return (feed.get("today") is None and days == [] and source.get("dataAsOf") is None
                and feed.get("retrievedAt") is None and feed.get("lastSuccessfulAt") is None
                and valid_iso_timestamp(feed.get("lastAttemptAt")) and bool(feed.get("lastError")))
    if len(days) != 7:
        return False
    for item in days:
        if not isinstance(item, dict) or not isinstance(item.get("date"), str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", item["date"]):
            return False
        if type(item.get("index")) is not int or item["index"] < 1 or item["index"] > 5:
            return False
    if not valid_iso_timestamp(feed.get("retrievedAt")) or not valid_iso_timestamp(feed.get("lastSuccessfulAt")) or not valid_iso_timestamp(source.get("dataAsOf")):
        return False
    if feed.get("lastAttemptAt") is not None and not valid_iso_timestamp(feed.get("lastAttemptAt")):
        return False
    if source.get("lastModifiedAt") is not None and not valid_iso_timestamp(source.get("lastModifiedAt")):
        return False
    for previous, current in zip(days, days[1:]):
        if datetime.fromisoformat(current["date"]).date() - datetime.fromisoformat(previous["date"]).date() != timedelta(days=1):
            return False
    if feed.get("today") is not None and feed["today"] not in days:
        return False
    if feed["status"] == "ok" and feed.get("today") is None:
        return False
    if feed.get("lastError") is not None and not valid_iso_timestamp(feed.get("lastAttemptAt")):
        return False
    return True

def build_feed(payload, now=None, last_modified=None):
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    now = now.astimezone(timezone.utc)
    issued, indices = parse_forecast_csv(payload)
    days = [{"date": (issued.date() + timedelta(days=offset)).isoformat(), "index": value} for offset, value in enumerate(indices)]
    local_today = now.astimezone(BERLIN).date().isoformat()
    today = next((item for item in days if item["date"] == local_today), None)
    source_modified = None
    if last_modified:
        try:
            source_modified = parsedate_to_datetime(last_modified).astimezone(timezone.utc)
        except (TypeError, ValueError, OverflowError) as exc:
            raise SourceError("DWD-Last-Modified ungültig") from exc
    freshness_reference = source_modified or issued
    age = (now - freshness_reference).total_seconds()
    fresh = today is not None and 0 <= age <= FRESHNESS_HOURS * 3600
    return {
        "schemaVersion": 1,
        "station": {"name": STATION_NAME, "id": STATION_ID},
        "status": "ok" if fresh else "stale",
        "statusReason": "DWD-Prognose ist aktuell" if fresh else "DWD-Prognose ist veraltet oder enthaelt keinen Wert fuer heute",
        "retrievedAt": iso(now),
        "lastSuccessfulAt": iso(now),
        "lastAttemptAt": iso(now),
        "source": {
            "provider": PROVIDER,
            "url": SOURCE_URL,
            "productVersion": "v2-0--0",
            "dataAsOf": iso(issued),
            "lastModifiedAt": iso(source_modified) if source_modified else None,
            "license": LICENSE
        },
        "today": today,
        "days": days
    }

def error_feed(previous, now, message):
    now = now.astimezone(timezone.utc)
    if validate_feed(previous) and previous.get("status") != "error":
        result = dict(previous)
        result["status"] = "stale"
        result["statusReason"] = "Abruf/Verarbeitung fehlgeschlagen; gespeicherte Prognose bleibt ausdruecklich veraltet"
        result["lastAttemptAt"] = iso(now)
        result["lastError"] = message
        return result
    return {
        "schemaVersion": 1,
        "station": {"name": STATION_NAME, "id": STATION_ID},
        "status": "error",
        "statusReason": "Kein erfolgreicher, validierter DWD-Abruf im Data Hub vorhanden",
        "retrievedAt": None,
        "lastSuccessfulAt": None,
        "lastAttemptAt": iso(now),
        "lastError": message,
        "source": {"provider": PROVIDER, "url": SOURCE_URL, "productVersion": "v2-0--0", "dataAsOf": None, "lastModifiedAt": None, "license": LICENSE},
        "today": None,
        "days": []
    }

def fetch_source(timeout=20):
    request = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "lhh-data-hub-graslandfeuerindex/1.0", "Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status != 200:
                raise SourceError("DWD-HTTP-Status-%d" % response.status)
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            last_modified = response.headers.get("Last-Modified")
    except urllib.error.HTTPError as exc:
        raise SourceError("DWD-HTTP-Status-%d" % exc.code) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SourceError("DWD-Abruf fehlgeschlagen (%s)" % type(getattr(exc, "reason", exc)).__name__) from exc
    if len(payload) > MAX_RESPONSE_BYTES:
        raise SourceError("DWD-Antwort überschreitet Größenlimit")
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(payload)) as compressed:
            data = compressed.read(MAX_CSV_BYTES + 1)
    except (OSError, EOFError, zlib.error) as exc:
        raise SourceError("DWD-GZIP-Dekomprimierung fehlgeschlagen") from exc
    if len(data) > MAX_CSV_BYTES:
        raise SourceError("DWD-CSV überschreitet Größenlimit")
    return data, last_modified

def atomic_write(path, feed):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name, dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(feed, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def update_feed(output_path, now=None, fetcher=fetch_source):
    now = now or datetime.now(timezone.utc)
    path = Path(output_path)
    try:
        previous = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        previous = None
    try:
        payload, modified = fetcher()
        feed = build_feed(payload, now=now, last_modified=modified)
        failed = False
    except SourceError as exc:
        feed = error_feed(previous, now, str(exc))
        failed = True
    except Exception:
        feed = error_feed(previous, now, "GLFI-Verarbeitung fehlgeschlagen")
        failed = True
    atomic_write(path, feed)
    return feed, failed

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("data/generated/graslandfeuerindex.json"))
    parser.add_argument("--validate-only", action="store_true", help="validates existing JSON without fetching")
    args = parser.parse_args()
    if args.validate_only:
        try:
            feed = json.loads(args.output.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SystemExit("GLFI-Ausgabe fehlt oder ist ungültiges JSON") from exc
        if not validate_feed(feed):
            raise SystemExit("GLFI-Ausgabe verletzt den Datenvertrag")
        print("GLFI JSON-Vertrag gültig; status=%s dataAsOf=%s lastSuccessfulAt=%s" % (
            feed["status"], feed["source"].get("dataAsOf"), feed.get("lastSuccessfulAt")))
        return
    feed, failed = update_feed(args.output)
    print("GLFI status=%s dataAsOf=%s retrievedAt=%s lastSuccessfulAt=%s" % (
        feed["status"], feed["source"].get("dataAsOf"), feed.get("retrievedAt"), feed.get("lastSuccessfulAt")))
    if feed.get("lastError"):
        print("GLFI diagnostic=%s" % feed["lastError"])
    if failed:
        raise SystemExit(1)

if __name__ == "__main__":
    main()
