#!/usr/bin/env python3
"""Read-only fetch and normalization prototype for public Brandenburg gauges."""
from __future__ import annotations
import argparse
import csv
import io
import json
import math
import os
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BASE_URL = "https://pegelportal.brandenburg.de/messstelle.php"
LOCAL_TZ = ZoneInfo("Europe/Berlin")
FRESHNESS_MINUTES = 45
MAX_RESPONSE_BYTES = 2_000_000
STATIONS = (
    {"key": "lauchhammer", "name": "Lauchhammer", "stationNumber": "5530401", "river": "Schwarze Elster"},
    {"key": "biehlen-1", "name": "Biehlen 1", "stationNumber": "5530302", "river": "Schwarze Elster"},
)
SENTINELS = {-777.0}

class SourceError(Exception):
    pass

def endpoint(station_number: str) -> str:
    query = urllib.parse.urlencode({"fgid": "7", "pkz": station_number, "thema": "q_graph"})
    return f"{BASE_URL}?{query}"

def require_aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("reference time must include a timezone")
    return value.astimezone(timezone.utc)

def parse_local_timestamp(raw: str) -> datetime:
    naive = datetime.strptime(raw.strip().strip('"'), "%d.%m.%Y %H:%M")
    # Reject ambiguous/nonexistent local wall times instead of inventing an offset.
    a = naive.replace(tzinfo=LOCAL_TZ, fold=0)
    b = naive.replace(tzinfo=LOCAL_TZ, fold=1)
    if a.utcoffset() != b.utcoffset():
        raise ValueError("ambiguous local timestamp")
    roundtrip = a.astimezone(timezone.utc).astimezone(LOCAL_TZ).replace(tzinfo=None)
    if roundtrip != naive:
        raise ValueError("nonexistent local timestamp")
    return a

def parse_csv(payload: bytes, station: dict, now: datetime | None = None) -> dict:
    now = require_aware_utc(now or datetime.now(timezone.utc))
    try:
        text = payload.decode("cp1252")
    except UnicodeDecodeError as exc:
        raise SourceError("CSV-Encoding nicht lesbar") from exc
    lines = list(csv.reader(io.StringIO(text, newline=""), delimiter=";"))
    if len(lines) < 2 or len(lines[0]) < 3:
        raise SourceError("CSV-Kopf oder Messwerte fehlen")
    header = ";".join(lines[0])
    station_match = re.search(r"Stationsnummer:\s*(\d+)", header)
    name_match = re.search(r"Stationsname:\s*([^;\"]+)", header)
    if not station_match or station_match.group(1) != station["stationNumber"]:
        raise SourceError("Stationskennung in Antwort stimmt nicht")
    if not name_match or name_match.group(1).strip() != station["name"]:
        raise SourceError("Stationsname in Antwort stimmt nicht")
    valid = []
    invalid_count = 0
    for row in lines[1:]:
        if len(row) < 2:
            invalid_count += 1
            continue
        try:
            measured_local = parse_local_timestamp(row[0])
            value = float(row[1].strip().strip('"').replace(",", "."))
            if not math.isfinite(value) or value in SENTINELS or value < 0 or value > 2000:
                invalid_count += 1
                continue
        except (ValueError, IndexError):
            invalid_count += 1
            continue
        valid.append((measured_local.astimezone(timezone.utc), measured_local, value))
    if not valid:
        raise SourceError("Keine gültigen Messwerte in der Antwort")
    valid.sort(key=lambda x: x[0])
    utc, local, value = valid[-1]
    age_seconds = (now - utc).total_seconds()
    if age_seconds < -300:
        raise SourceError("Messzeitpunkt liegt unerwartet mehr als fünf Minuten in der Zukunft")
    if age_seconds > FRESHNESS_MINUTES * 60:
        status, reason = "stale", f"Letzter gültiger Messwert älter als {FRESHNESS_MINUTES} Minuten"
    else:
        status, reason = "ok", "Messwert innerhalb der Frischegrenze"
    history = [{"measuredAt": dt.isoformat(), "measuredAtUtc": ts.isoformat().replace("+00:00", "Z"), "waterLevelCm": val}
               for ts, dt, val in valid[-97:]]
    return {
        "schemaVersion": 1,
        "station": station["name"],
        "stationNumber": station["stationNumber"],
        "river": station["river"],
        "latestMeasurement": {"waterLevelCm": value, "measuredAt": local.isoformat(), "measuredAtUtc": utc.isoformat().replace("+00:00", "Z")},
        "retrievedAt": now.isoformat().replace("+00:00", "Z"),
        "ageMinutes": max(0, int(age_seconds // 60)),
        "freshnessThresholdMinutes": FRESHNESS_MINUTES,
        "status": status,
        "statusReason": reason,
        "invalidRowsSkipped": invalid_count,
        "history": history,
        "source": {"provider": "Landesamt für Umwelt Brandenburg (LfU)", "url": endpoint(station["stationNumber"]), "format": "CSV; semikolongetrennt; Ortszeit Europe/Berlin"},
        "officialAlarmLevel": None,
        "officialAlarmLevelNote": "Keine amtliche Alarmstufe aus dem Messwert abgeleitet."
    }

def error_from_previous(station: dict, previous: dict | None, now: datetime, error: str) -> dict:
    now_utc = require_aware_utc(now)
    now_iso = now_utc.isoformat().replace("+00:00", "Z")
    # Accept the Phase 4 local snapshot schema during this local migration.
    measurement = (previous.get("latestMeasurement") or previous.get("current")) if isinstance(previous, dict) else None
    if (previous and previous.get("stationNumber") == station["stationNumber"]
            and isinstance(measurement, dict)):
        try:
            value = float(measurement.get("waterLevelCm"))
            measured_at = measurement.get("measuredAtUtc")
            measured_dt = require_aware_utc(datetime.fromisoformat(measured_at.replace("Z", "+00:00")))
            if not math.isfinite(value) or value < 0 or value > 2000:
                raise ValueError("previous water level is implausible")
        except (ValueError, TypeError, AttributeError):
            measurement = None
        if measurement is not None:
            result = dict(previous)
            age_minutes = max(0, int((now_utc - measured_dt).total_seconds() // 60))
            result.pop("current", None)
            result["latestMeasurement"] = measurement
            result["ageMinutes"] = age_minutes
            result["status"] = "error"
            result["statusReason"] = "Abruf oder Verarbeitung fehlgeschlagen; gespeicherter Messwert ist nicht als aktuell zu verwenden"
            result["lastAttemptAt"] = now_iso
            result["lastError"] = error[:300]
            return result
    return {
        "schemaVersion": 1, "station": station["name"], "stationNumber": station["stationNumber"], "river": station["river"],
        "latestMeasurement": None, "retrievedAt": None, "lastAttemptAt": now_iso, "ageMinutes": None,
        "freshnessThresholdMinutes": FRESHNESS_MINUTES, "status": "error", "statusReason": "Abruf oder Verarbeitung fehlgeschlagen; kein gültiger Messwert verfügbar",
        "lastError": error[:300], "history": [], "source": {"provider": "Landesamt für Umwelt Brandenburg (LfU)", "url": endpoint(station["stationNumber"])},
        "officialAlarmLevel": None, "officialAlarmLevelNote": "Keine amtliche Alarmstufe aus Messwerten abgeleitet."
    }

def fetch_station(station: dict, timeout: float = 20) -> bytes:
    body = urllib.parse.urlencode({"smode": "c", "sdatum": "stunde"}).encode()
    request = urllib.request.Request(endpoint(station["stationNumber"]), data=body, method="POST", headers={
        "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "lhh-data-hub-local-prototype/0.1",
        "Cache-Control": "no-cache", "Pragma": "no-cache"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status != 200:
                raise SourceError(f"HTTP {response.status}")
            data = response.read(MAX_RESPONSE_BYTES + 1)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SourceError(f"Abruf fehlgeschlagen: {exc}") from exc
    if len(data) > MAX_RESPONSE_BYTES:
        raise SourceError("Antwort überschreitet Größenlimit")
    return data

def atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=path.name, dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)

def run(output_dir: Path, now: datetime | None = None) -> list[dict]:
    now = require_aware_utc(now or datetime.now(timezone.utc))
    results = []
    for station in STATIONS:
        path = output_dir / f"pegel-{station['key']}.json"
        try:
            result = parse_csv(fetch_station(station), station, now)
        except Exception as exc:  # isolate failures per station
            previous = None
            try:
                previous = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                pass
            result = error_from_previous(station, previous, now, str(exc))
        result["lastAttemptAt"] = now.isoformat().replace("+00:00", "Z")
        atomic_json(path, result)
        results.append(result)
    return results

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=Path("data/generated"))
    args = parser.parse_args()
    for result in run(args.output_dir):
        measurement = result.get("latestMeasurement")
        print(f"{result['station']} ({result['stationNumber']}): status={result['status']} value={measurement and measurement['waterLevelCm']} cm measuredAt={measurement and measurement['measuredAt']} retrievedAt={result.get('retrievedAt')} ageMinutes={result.get('ageMinutes')}")

if __name__ == "__main__":
    main()
