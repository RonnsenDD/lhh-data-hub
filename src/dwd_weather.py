#!/usr/bin/env python3
"""DWD-only local weather feed prototype; standard library only.

The parser accepts DWD CDC 10-minute ZIP/CSV bytes. It never substitutes a
forecast for an observation, and emits explicit unavailable fields when no
verified DWD source has been configured for that field.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import tempfile
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SOURCE_URL = "https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/10_minutes/air_temperature/now/10minutenwerte_TU_02627_now.zip"
SOURCE_PROVIDER = "Deutscher Wetterdienst (DWD), Climate Data Center (CDC)"
STATION = {"id": "02627", "name": "Schipkau-Klettwitz"}
FRESHNESS_MINUTES = 60
MAX_DOWNLOAD_BYTES = 2_000_000
MAX_CSV_BYTES = 4_000_000
MAX_ZIP_MEMBERS = 8
MISSING = -999.0


class DwdSourceError(ValueError):
    """Raised when a DWD response cannot safely be interpreted."""


def utc_iso(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamp must include a timezone")
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_dwd_timestamp(value: str) -> datetime:
    """Parse DWD MESS_DATUM as UTC (10- or 12-digit timestamp)."""
    raw = value.strip()
    fmt = {10: "%Y%m%d%H", 12: "%Y%m%d%H%M"}.get(len(raw))
    if fmt is None or not raw.isdigit():
        raise ValueError("invalid MESS_DATUM")
    return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)


def _finite_measurement(value: str | None, *, minimum: float, maximum: float) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(value.strip().replace(",", "."))
    except (ValueError, AttributeError):
        return None
    if not math.isfinite(parsed) or parsed == MISSING or not minimum <= parsed <= maximum:
        return None
    return parsed


def _zip_csv(payload: bytes) -> str:
    if not payload or len(payload) > MAX_DOWNLOAD_BYTES:
        raise DwdSourceError("DWD ZIP is empty or exceeds the download size limit")
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            members = [item for item in archive.infolist() if not item.is_dir()]
            if len(members) > MAX_ZIP_MEMBERS:
                raise DwdSourceError("DWD ZIP contains too many files")
            csv_members = [item for item in members if item.filename.lower().endswith(".txt")]
            if len(csv_members) != 1:
                raise DwdSourceError("DWD ZIP must contain exactly one data TXT file")
            member = csv_members[0]
            if member.file_size > MAX_CSV_BYTES:
                raise DwdSourceError("DWD CSV exceeds the decompressed size limit")
            if member.filename.startswith(("/", "\\")) or ".." in Path(member.filename).parts:
                raise DwdSourceError("unsafe path in DWD ZIP")
            raw = archive.read(member)
    except (zipfile.BadZipFile, OSError, RuntimeError) as exc:
        raise DwdSourceError("DWD ZIP could not be read") from exc
    if len(raw) > MAX_CSV_BYTES:
        raise DwdSourceError("DWD CSV exceeds the decompressed size limit")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            return raw.decode("cp1252")
        except UnicodeDecodeError as exc:
            raise DwdSourceError("DWD CSV encoding is unsupported") from exc


def parse_cdc_observations(payload: bytes, retrieved_at: datetime, *, station: dict[str, str] = STATION,
                           max_age_minutes: int = FRESHNESS_MINUTES) -> dict[str, Any]:
    """Parse one CDC 10-minute TU now ZIP and keep values tied to their UTC time."""
    if retrieved_at.tzinfo is None or retrieved_at.utcoffset() is None:
        raise ValueError("retrieved_at must include a timezone")
    if max_age_minutes < 0:
        raise ValueError("max_age_minutes must be non-negative")
    text = _zip_csv(payload)
    reader = csv.DictReader(io.StringIO(text, newline=""), delimiter=";")
    if not reader.fieldnames or not {"MESS_DATUM", "TT_10", "RF_10", "PP_10"}.issubset(reader.fieldnames):
        raise DwdSourceError("DWD CSV is missing required columns")

    rows: list[tuple[datetime, dict[str, float | None], int | None]] = []
    invalid_rows = 0
    for row in reader:
        try:
            measured_at = parse_dwd_timestamp(row.get("MESS_DATUM", ""))
        except ValueError:
            invalid_rows += 1
            continue
        values = {
            "temperatureC": _finite_measurement(row.get("TT_10"), minimum=-90, maximum=65),
            "relativeHumidityPercent": _finite_measurement(row.get("RF_10"), minimum=0, maximum=100),
            "stationPressureHpa": _finite_measurement(row.get("PP_10"), minimum=300, maximum=1200),
            "dewPointC": _finite_measurement(row.get("TD_10"), minimum=-100, maximum=65),
        }
        if not any(value is not None for value in values.values()):
            invalid_rows += 1
            continue
        try:
            quality = int(row["QN"]) if row.get("QN", "").strip().isdigit() else None
        except (KeyError, ValueError):
            quality = None
        rows.append((measured_at, values, quality))
    if not rows:
        raise DwdSourceError("no valid observations in DWD response")
    rows.sort(key=lambda item: item[0])
    measured_at, values, quality = rows[-1]
    age_minutes = max(0.0, (retrieved_at.astimezone(timezone.utc) - measured_at).total_seconds() / 60)
    if measured_at > retrieved_at.astimezone(timezone.utc).replace(microsecond=0):
        status, reason = "error", "Observation timestamp is in the future"
    elif age_minutes > max_age_minutes:
        status, reason = "stale", f"Latest observation is older than {max_age_minutes} minutes"
    elif all(value is not None for value in values.values()):
        status, reason = "ok", "DWD observation within configured freshness threshold"
    else:
        status, reason = "partial", "DWD response is current but one or more fields are missing"

    return {
        "schemaVersion": 1,
        "location": {"key": "lauchhammer", "name": "Lauchhammer", "latitude": 51.4693, "longitude": 13.76319},
        "status": status,
        "statusReason": reason,
        "observation": {
            "station": {"id": station["id"], "name": station["name"]},
            "measuredAt": utc_iso(measured_at),
            "retrievedAt": utc_iso(retrieved_at),
            "ageMinutes": round(age_minutes, 1),
            "freshnessThresholdMinutes": max_age_minutes,
            "qualityLevel": quality,
            "values": values,
        },
        "forecast": {
            "provider": "DWD MOSMIX",
            "status": "unavailable",
            "stationId": None,
            "issuedAt": None,
            "points": [],
            "reason": "No local MOSMIX point with verified current updates is configured.",
        },
        "unavailableParameters": ["windSpeedKmh", "windDirectionDeg", "windGustKmh", "precipitationMm", "weatherCode"],
        "source": {
            "provider": SOURCE_PROVIDER,
            "product": "10-minute air temperature / humidity / station pressure",
            "url": SOURCE_URL,
            "stationId": station["id"],
            "timeBasis": "UTC (DWD MESS_DATUM since 2000)",
            "citation": "Daten: Deutscher Wetterdienst (DWD), Climate Data Center (CDC), 10-Minutenwerte; Station Schipkau-Klettwitz (02627). CC BY 4.0.",
            "qualityNote": "CDC now/ data are not yet finally quality-controlled.",
        },
        "invalidRowsSkipped": invalid_rows,
    }


def fetch_dwd_zip(url: str = SOURCE_URL, *, timeout: float = 20, max_bytes: int = MAX_DOWNLOAD_BYTES) -> bytes:
    request = urllib.request.Request(url, headers={
        "User-Agent": "lhh-data-hub-dwd-weather-local/0.1",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    })
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status != 200:
                raise DwdSourceError(f"DWD returned HTTP {response.status}")
            payload = response.read(max_bytes + 1)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise DwdSourceError("DWD request failed") from exc
    if len(payload) > max_bytes:
        raise DwdSourceError("DWD response exceeds size limit")
    return payload


def mark_error(previous: dict[str, Any] | None, now: datetime, error: str) -> dict[str, Any]:
    """Retain a compatible last snapshot but mark it unusable as current."""
    attempted = utc_iso(now)
    if isinstance(previous, dict) and previous.get("schemaVersion") == 1 and isinstance(previous.get("observation"), dict):
        result = dict(previous)
        result["status"] = "error"
        result["statusReason"] = "DWD fetch or parse failed; retained observation is not current"
        result["lastAttemptAt"] = attempted
        result["lastError"] = error[:240]
        return result
    return {
        "schemaVersion": 1,
        "location": {"key": "lauchhammer", "name": "Lauchhammer", "latitude": 51.4693, "longitude": 13.76319},
        "status": "error",
        "statusReason": "DWD fetch or parse failed; no validated observation is available",
        "observation": None,
        "forecast": {"provider": "DWD MOSMIX", "status": "unavailable", "stationId": None, "issuedAt": None, "points": []},
        "lastAttemptAt": attempted,
        "lastError": error[:240],
        "source": {"provider": SOURCE_PROVIDER, "url": SOURCE_URL},
    }


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name, dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def run(output: Path, *, now: datetime | None = None) -> dict[str, Any]:
    instant = now or datetime.now(timezone.utc)
    if instant.tzinfo is None or instant.utcoffset() is None:
        raise ValueError("now must include a timezone")
    previous: dict[str, Any] | None = None
    try:
        previous = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        pass
    try:
        result = parse_cdc_observations(fetch_dwd_zip(), instant)
    except Exception as exc:  # preserve stale data and emit explicit technical status
        result = mark_error(previous, instant, str(exc))
    result["lastAttemptAt"] = utc_iso(instant)
    atomic_json(output, result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("data/generated/weather-dwd.json"))
    args = parser.parse_args()
    result = run(args.output)
    print(f"DWD weather: status={result['status']} observation={result.get('observation') and result['observation'].get('measuredAt')} forecast={result['forecast']['status']}")
    if result["status"] == "error":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
