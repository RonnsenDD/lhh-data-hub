#!/usr/bin/env python3
"""Read the official MLEUV OSL fire-danger table and publish a public snapshot."""
from __future__ import annotations

import argparse
import datetime as dt
from html.parser import HTMLParser
import json
import os
import re
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

SOURCE_URL = (
    "https://mleuv.brandenburg.de/mleuv/de/umwelt/forst/waldschutz/"
    "waldbrandgefahr-in-brandenburg/waldbrandgefahrenstufen/"
)
DISTRICT_NAME = "Oberspreewald-Lausitz"
DISTRICT_CODE = "12066"  # offizieller Regionalschlüssel des Landkreises
PROVIDER = "Ministerium für Land- und Ernährungswirtschaft, Umwelt und Verbraucherschutz des Landes Brandenburg"
LICENSE_NOTICE = "Auf der Quellseite ist keine ausdrückliche Datenlizenz ausgewiesen."
BERLIN = ZoneInfo("Europe/Berlin")
MAX_RESPONSE_BYTES = 2_000_000
OUTPUT_PATH = Path("data/generated/waldbrandgefahrenstufe-osl.json")

LEVEL_LABELS = {
    1: "sehr geringe Gefahr",
    2: "geringe Gefahr",
    3: "mittlere Gefahr",
    4: "hohe Gefahr",
    5: "sehr hohe Gefahr",
}


class SourceError(ValueError):
    """A safe, non-sensitive source or validation failure."""


class VisibleText(HTMLParser):
    """Extract visible HTML text without script/style or hidden SVG values."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in {"script", "style", "noscript", "svg"}:
            self._skip += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {"script", "style", "noscript", "svg"} and self._skip:
            self._skip -= 1

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self.parts.append(data)


def iso_utc(value: dt.datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("Zeitpunkt muss eine Zeitzone enthalten")
    return value.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def berlin_today(now: dt.datetime | None = None) -> dt.date:
    value = now or dt.datetime.now(BERLIN)
    if value.tzinfo is None:
        raise ValueError("now muss eine Zeitzone enthalten")
    return value.astimezone(BERLIN).date()


def parse_source(html: str) -> tuple[dt.date, int]:
    if not isinstance(html, str) or "<html" not in html.lower() or "</html" not in html.lower():
        raise SourceError("MLEUV-Antwort ist kein vollständiges HTML-Dokument")

    parser = VisibleText()
    try:
        parser.feed(html)
        parser.close()
    except (ValueError, AssertionError) as exc:
        raise SourceError("MLEUV-HTML konnte nicht verarbeitet werden") from exc
    text = re.sub(r"\s+", " ", " ".join(parser.parts)).strip()

    date_matches = re.findall(r"\bDaten\s+vom\s*:?\s*(\d{2}\.\d{2}\.\d{4})", text, re.I)
    if len(date_matches) != 1:
        raise SourceError("MLEUV-Seite enthält kein eindeutiges Veröffentlichungsdatum")
    try:
        source_date = dt.datetime.strptime(date_matches[0], "%d.%m.%Y").date()
    except ValueError as exc:
        raise SourceError("MLEUV-Veröffentlichungsdatum ist ungültig") from exc

    # In the current MLEUV table the county and level are in adjacent cells,
    # whose visible text joins to "Oberspreewald-Lausitz 1". Older page forms
    # with a pipe or colon remain accepted, matching the already-tested parser.
    stage_matches = re.findall(
        r"\bOberspreewald\s*[-–]\s*Lausitz\s*(?:[|:]\s*|\s+)([1-5])\b",
        text,
        re.I,
    )
    if len(stage_matches) != 1:
        raise SourceError("MLEUV-Seite enthält keine eindeutige OSL-Stufe")
    return source_date, int(stage_matches[0])


def fetch_source(opener=None, timeout: int = 20) -> tuple[dt.date, int]:
    opener = opener or urllib.request.urlopen
    request = urllib.request.Request(
        SOURCE_URL,
        headers={
            "User-Agent": "lhh-data-hub-waldbrandgefahrenstufe/1.0",
            "Accept": "text/html",
            "Cache-Control": "no-cache",
        },
    )
    try:
        with opener(request, timeout=timeout) as response:
            status = getattr(response, "status", 200)
            if status != 200:
                raise SourceError(f"MLEUV-HTTP-Status-{status}")
            content_type = response.headers.get("Content-Type", "")
            if "html" not in content_type.lower():
                raise SourceError("MLEUV-Antwort hat keinen HTML-Content-Type")
            payload = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        raise SourceError(f"MLEUV-HTTP-Status-{exc.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise SourceError(f"MLEUV-Abruf fehlgeschlagen ({type(reason).__name__})") from None

    if len(payload) > MAX_RESPONSE_BYTES:
        raise SourceError("MLEUV-Antwort überschreitet das Größenlimit")
    try:
        html = payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SourceError("MLEUV-HTML-Encoding ist ungültig") from exc
    return parse_source(html)


def _is_iso_date(value: object) -> bool:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return False
    try:
        return dt.date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def _is_iso_timestamp(value: object, optional: bool = False) -> bool:
    if value is None:
        return optional
    if not isinstance(value, str) or not value.endswith("Z"):
        return False
    try:
        return dt.datetime.fromisoformat(value[:-1] + "+00:00").tzinfo is not None
    except ValueError:
        return False


def validate_feed(feed: object) -> bool:
    if not isinstance(feed, dict) or feed.get("schemaVersion") != 1:
        return False
    if feed.get("district") != {"name": DISTRICT_NAME, "regionalschluessel": DISTRICT_CODE}:
        return False
    source = feed.get("source")
    if not isinstance(source, dict) or source.get("provider") != PROVIDER or source.get("url") != SOURCE_URL:
        return False
    if source.get("license") != LICENSE_NOTICE:
        return False
    if feed.get("status") not in {"current", "stale", "unavailable"}:
        return False
    if feed.get("fetchStatus") not in {"success", "error", "not-attempted"}:
        return False
    for field in ("lastAttemptAt", "retrievedAt", "lastSuccessfulAt"):
        if not _is_iso_timestamp(feed.get(field), optional=True):
            return False
    if not isinstance(feed.get("statusReason"), str) or not feed["statusReason"].strip():
        return False
    if feed.get("lastError") is not None and not isinstance(feed.get("lastError"), str):
        return False

    source_date = feed.get("sourceDate")
    level = feed.get("level")
    description = feed.get("description")
    if source_date is None:
        return (
            level is None
            and description is None
            and feed.get("status") == "unavailable"
            and feed.get("lastSuccessfulAt") is None
            and feed.get("retrievedAt") is None
        )
    if not _is_iso_date(source_date):
        return False
    if type(level) is not int or level not in LEVEL_LABELS or description != LEVEL_LABELS[level]:
        return False
    if not _is_iso_timestamp(feed.get("lastSuccessfulAt")) or not _is_iso_timestamp(feed.get("retrievedAt")):
        return False
    if feed.get("fetchStatus") == "not-attempted":
        return False
    return True


def _snapshot(source_date: dt.date, level: int, now: dt.datetime, fetch_status: str = "success") -> dict:
    today = berlin_today(now)
    if source_date > today:
        raise SourceError("MLEUV-Quelldatum liegt in der Zukunft")
    if type(level) is not int or level not in LEVEL_LABELS:
        raise SourceError("MLEUV-Stufe liegt außerhalb der Klassen 1 bis 5")
    status = "current" if source_date == today else "stale"
    reason = (
        "Offizielle Tagesstufe für Europe/Berlin geprüft"
        if status == "current"
        else "Offizielles Quelldatum ist nicht der heutige Kalendertag in Europe/Berlin"
    )
    retrieved = iso_utc(now)
    return {
        "schemaVersion": 1,
        "district": {"name": DISTRICT_NAME, "regionalschluessel": DISTRICT_CODE},
        "level": level,
        "description": LEVEL_LABELS[level],
        "sourceDate": source_date.isoformat(),
        "retrievedAt": retrieved,
        "lastSuccessfulAt": retrieved,
        "lastAttemptAt": retrieved,
        "status": status,
        "statusReason": reason,
        "fetchStatus": fetch_status,
        "lastError": None,
        "source": {
            "provider": PROVIDER,
            "url": SOURCE_URL,
            "attribution": PROVIDER,
            "license": LICENSE_NOTICE,
        },
    }


def initial_feed(now: dt.datetime | None = None, error: str = "Noch kein erfolgreicher Abruf im Data Hub") -> dict:
    timestamp = iso_utc(now) if now is not None else None
    feed = {
        "schemaVersion": 1,
        "district": {"name": DISTRICT_NAME, "regionalschluessel": DISTRICT_CODE},
        "level": None,
        "description": None,
        "sourceDate": None,
        "retrievedAt": None,
        "lastSuccessfulAt": None,
        "lastAttemptAt": timestamp,
        "status": "unavailable",
        "statusReason": "Es liegt noch kein erfolgreich validierter MLEUV-Datensatz vor",
        "fetchStatus": "not-attempted" if timestamp is None else "error",
        "lastError": error,
        "source": {
            "provider": PROVIDER,
            "url": SOURCE_URL,
            "attribution": PROVIDER,
            "license": LICENSE_NOTICE,
        },
    }
    return feed


def error_feed(previous: object, now: dt.datetime, message: str) -> dict:
    timestamp = iso_utc(now)
    if validate_feed(previous) and previous.get("sourceDate") is not None:
        result = dict(previous)
        result["status"] = "current" if previous["sourceDate"] == berlin_today(now).isoformat() else "stale"
        result["statusReason"] = (
            "Letzter Abruf fehlgeschlagen; Aktualität bleibt anhand des offiziellen Quelldatums bewertet"
        )
        result["fetchStatus"] = "error"
        result["lastAttemptAt"] = timestamp
        result["lastError"] = message
        return result
    return initial_feed(now, message)


def atomic_write(path: Path, feed: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name, dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(feed, output, ensure_ascii=False, indent=2)
            output.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def update_feed(output_path: Path, now: dt.datetime | None = None, fetcher=fetch_source) -> tuple[dict, bool]:
    now = now or dt.datetime.now(dt.timezone.utc)
    if now.tzinfo is None:
        raise ValueError("now muss eine Zeitzone enthalten")
    output_path = Path(output_path)
    try:
        previous = json.loads(output_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        previous = None

    try:
        source_date, level = fetcher()
        feed = _snapshot(source_date, level, now)
        if validate_feed(previous) and previous.get("sourceDate"):
            previous_date = dt.date.fromisoformat(previous["sourceDate"])
            if source_date < previous_date:
                raise SourceError("MLEUV-Quelldatum ist gegenüber dem letzten validierten Datensatz zurückgegangen")
        failed = False
    except SourceError as exc:
        feed = error_feed(previous, now, str(exc))
        failed = True
    except Exception:
        feed = error_feed(previous, now, "MLEUV-Verarbeitung fehlgeschlagen")
        failed = True

    atomic_write(output_path, feed)
    return feed, failed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--source-only", action="store_true", help="Quelle live prüfen, ohne eine Datei zu schreiben")
    args = parser.parse_args(argv)

    if args.validate_only:
        try:
            feed = json.loads(args.output.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SystemExit("Waldbrand-Ausgabe fehlt oder ist ungültiges JSON") from exc
        if not validate_feed(feed):
            raise SystemExit("Waldbrand-Ausgabe verletzt den Datenvertrag")
        print(f"Waldbrand-JSON gültig; status={feed['status']} sourceDate={feed['sourceDate']} lastSuccessfulAt={feed['lastSuccessfulAt']}")
        return 0

    if args.source_only:
        try:
            source_date, level = fetch_source()
            today = berlin_today()
            status = "current" if source_date == today else "stale"
            if source_date > today:
                raise SourceError("MLEUV-Quelldatum liegt in der Zukunft")
            print(f"MLEUV Quelle geprüft: district={DISTRICT_NAME} regionalschluessel={DISTRICT_CODE} level={level} sourceDate={source_date.isoformat()} status={status}")
            return 0 if status == "current" else 2
        except SourceError as exc:
            print(f"MLEUV-Quellenprüfung fehlgeschlagen: {exc}")
            return 1

    feed, failed = update_feed(args.output)
    print(
        f"Waldbrand status={feed['status']} fetchStatus={feed['fetchStatus']} "
        f"sourceDate={feed['sourceDate']} retrievedAt={feed['retrievedAt']} "
        f"lastAttemptAt={feed['lastAttemptAt']}"
    )
    if feed.get("lastError"):
        print(f"Waldbrand Fehlergrund={feed['lastError']}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
