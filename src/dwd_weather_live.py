#!/usr/bin/env python3
"""DWD-only local weather snapshot using observed CDC and forecast MOSMIX data.

This module is intentionally separate from the existing gauge pipeline. It uses
only public DWD endpoints and keeps every observation series tied to its own
station and source timestamp. Running it is an explicit local operation.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import urllib.error
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from src.dwd_weather import DwdSourceError, _finite_measurement, atomic_json, parse_dwd_timestamp, utc_iso

LOCATION = {"key": "lauchhammer", "name": "Lauchhammer", "latitude": 51.4693, "longitude": 13.76319}
FRESHNESS_MINUTES = 60
MOSMIX_MAX_AGE_HOURS = 12
BERLIN = ZoneInfo("Europe/Berlin")
MAX_ARCHIVE_BYTES = 8_000_000
MAX_XML_BYTES = 5_000_000
MAX_ZIP_MEMBERS = 4
CDC_ROOT = "https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/10_minutes"
MOSMIX_URL = "https://opendata.dwd.de/weather/local_forecasts/mos/MOSMIX_L/single_stations/P0043/kml/MOSMIX_L_LATEST_P0043.kmz"

PRODUCTS: dict[str, dict[str, Any]] = {
    "temperatureHumidity": {
        "url": f"{CDC_ROOT}/air_temperature/now/10minutenwerte_TU_02627_now.zip",
        "station": {"id": "02627", "name": "Schipkau-Klettwitz", "latitude": 51.5554, "longitude": 13.8845, "distanceKm": 12.7},
        "product": "10-minute air temperature / relative humidity / dew point / station pressure",
        "columns": {"temperatureC": ("TT_10", -90, 65), "relativeHumidityPercent": ("RF_10", 0, 100), "dewPointC": ("TD_10", -100, 65)},
        "units": {"temperatureC": "°C", "relativeHumidityPercent": "%", "dewPointC": "°C"},
    },
    "stationPressure": {
        "url": f"{CDC_ROOT}/air_temperature/now/10minutenwerte_TU_01001_now.zip",
        "station": {"id": "01001", "name": "Doberlug-Kirchhain", "latitude": 51.6451, "longitude": 13.5747, "distanceKm": 23.5},
        "product": "10-minute station pressure",
        "columns": {"stationPressureHpa": ("PP_10", 300, 1200)},
        "units": {"stationPressureHpa": "hPa"},
    },
    "wind": {
        "url": f"{CDC_ROOT}/wind/now/10minutenwerte_wind_01001_now.zip",
        "station": {"id": "01001", "name": "Doberlug-Kirchhain", "latitude": 51.6451, "longitude": 13.5747, "distanceKm": 23.5},
        "product": "10-minute wind speed and direction",
        "columns": {"windSpeedKmh": ("FF_10", 0, 75), "windDirectionDeg": ("DD_10", 0, 360)},
        "units": {"windSpeedKmh": "km/h", "windDirectionDeg": "degree"},
        "conversions": {"windSpeedKmh": 3.6},
    },
    "windGust": {
        "url": f"{CDC_ROOT}/extreme_wind/now/10minutenwerte_extrema_wind_01001_now.zip",
        "station": {"id": "01001", "name": "Doberlug-Kirchhain", "latitude": 51.6451, "longitude": 13.5747, "distanceKm": 23.5},
        "product": "10-minute extreme wind (maximum gust)",
        "columns": {"windGustKmh": ("FX_10", 0, 100)},
        "units": {"windGustKmh": "km/h"},
        "conversions": {"windGustKmh": 3.6},
    },
    "precipitation": {
        "url": f"{CDC_ROOT}/precipitation/now/10minutenwerte_nieder_02627_now.zip",
        "station": {"id": "02627", "name": "Schipkau-Klettwitz", "latitude": 51.5554, "longitude": 13.8845, "distanceKm": 12.7},
        "product": "10-minute precipitation sum",
        "columns": {"precipitation10MinMm": ("RWS_10", 0, 1000)},
        "units": {"precipitation10MinMm": "mm"},
    },
}

MOSMIX_PARAMS = {
    "TTT": ("temperatureC", "kelvin_to_celsius"),
    "DD": ("windDirectionDeg", "identity"),
    "FF": ("windSpeedKmh", "ms_to_kmh"),
    "FX1": ("windGustKmh", "ms_to_kmh"),
    "RR1c": ("precipitation1hMm", "identity"),
    "PPPP": ("pressureHpa", "pa_to_hpa"),
    "ww": ("weatherCode", "identity"),
}

# Visual categories for MOSMIX `ww` (significant weather), not a replacement
# for the numeric DWD code. Ranges follow the DWD MOSMIX weather-parameter
# documentation and its WMO-derived weather families; unmapped codes stay
# neutral instead of being guessed.
DWD_WW_SYMBOL_RANGES: tuple[tuple[int, int, str], ...] = (
    (0, 3, "cloud"),
    (4, 9, "haze"),
    (10, 12, "fog"),
    (20, 29, "precipitation"),
    (30, 35, "haze"),
    (36, 39, "snow"),
    (40, 49, "fog"),
    (50, 59, "drizzle"),
    (60, 65, "rain"),
    (66, 67, "freezing_rain"),
    (68, 69, "rain"),
    (70, 79, "snow"),
    (80, 84, "rain_showers"),
    (85, 86, "snow_showers"),
    (87, 89, "rain_showers"),
    (90, 99, "thunderstorm"),
)


def weather_symbol(code: int | float) -> str:
    """Map an integer DWD MOSMIX ww code to a broad, neutral icon category."""
    if not math.isfinite(code) or not float(code).is_integer():
        return "unknown"
    numeric_code = int(code)
    for start, end, symbol in DWD_WW_SYMBOL_RANGES:
        if start <= numeric_code <= end:
            return symbol
    return "unknown"


def _read_zip_csv(payload: bytes) -> str:
    if not payload or len(payload) > MAX_ARCHIVE_BYTES:
        raise DwdSourceError("DWD CDC archive is empty or over the size limit")
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            members = [m for m in archive.infolist() if not m.is_dir()]
            if len(members) > MAX_ZIP_MEMBERS:
                raise DwdSourceError("DWD CDC archive has too many files")
            texts = [m for m in members if m.filename.lower().endswith(".txt")]
            if len(texts) != 1 or texts[0].file_size > MAX_XML_BYTES:
                raise DwdSourceError("DWD CDC archive must contain one bounded TXT file")
            raw = archive.read(texts[0])
    except (zipfile.BadZipFile, OSError, RuntimeError) as exc:
        raise DwdSourceError("DWD CDC archive could not be read") from exc
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp1252")


def parse_cdc_product(payload: bytes, retrieved_at: datetime, *, key: str,
                      max_age_minutes: int = FRESHNESS_MINUTES) -> dict[str, Any]:
    """Parse one configured CDC product, selecting the newest valid row."""
    if key not in PRODUCTS:
        raise ValueError(f"unsupported product: {key}")
    if retrieved_at.tzinfo is None or retrieved_at.utcoffset() is None:
        raise ValueError("retrieved_at must include a timezone")
    if max_age_minutes < 0:
        raise ValueError("max_age_minutes must be non-negative")
    spec = PRODUCTS[key]
    reader = csv.DictReader(io.StringIO(_read_zip_csv(payload)), delimiter=";")
    required = {"MESS_DATUM", "QN", *(column for column, _, _ in spec["columns"].values())}
    if not reader.fieldnames or not required.issubset(set(x.strip() for x in reader.fieldnames)):
        raise DwdSourceError(f"DWD {key} data are missing required columns")
    # DictReader retains spaces in some DWD header names; normalize them once.
    rows: list[tuple[datetime, dict[str, float | None], int | None]] = []
    skipped = 0
    for raw in reader:
        row = {str(k).strip(): v for k, v in raw.items() if k is not None}
        try:
            measured_at = parse_dwd_timestamp(row.get("MESS_DATUM", ""))
        except ValueError:
            skipped += 1
            continue
        values: dict[str, float | None] = {}
        for output_name, (column, low, high) in spec["columns"].items():
            value = _finite_measurement(row.get(column), minimum=low, maximum=high)
            if value is not None:
                value *= spec.get("conversions", {}).get(output_name, 1.0)
                if output_name == "windDirectionDeg" and value == 360:
                    value = 0.0
            values[output_name] = round(value, 2) if value is not None else None
        if not any(v is not None for v in values.values()):
            skipped += 1
            continue
        qn = row.get("QN", "").strip()
        rows.append((measured_at, values, int(qn) if qn.isdigit() else None))
    if not rows:
        raise DwdSourceError(f"DWD {key} response contains no valid observations")
    rows.sort(key=lambda item: item[0])
    measured_at, values, quality = rows[-1]
    now_utc = retrieved_at.astimezone(timezone.utc)
    age = (now_utc - measured_at).total_seconds() / 60
    if age < 0:
        status, reason = "error", "measurement timestamp is in the future"
    elif age > max_age_minutes:
        status, reason = "stale", f"measurement is older than {max_age_minutes} minutes"
    elif all(v is not None for v in values.values()):
        status, reason = "ok", "latest CDC measurement is within freshness limit"
    else:
        status, reason = "partial", "current product has missing parameter values"
    return {
        "status": status, "statusReason": reason,
        "station": spec["station"], "product": spec["product"],
        "measuredAt": utc_iso(measured_at), "measuredAtLocal": local_iso(measured_at),
        "retrievedAt": utc_iso(retrieved_at), "retrievedAtLocal": local_iso(retrieved_at),
        "ageMinutes": round(max(age, 0), 1), "freshnessThresholdMinutes": max_age_minutes,
        "qualityLevel": quality, "units": spec["units"], "values": values,
        "source": {"provider": "DWD Climate Data Center (CDC)", "url": spec["url"], "license": "CC BY 4.0"},
        "invalidRowsSkipped": skipped,
    }


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def local_iso(value: datetime) -> str:
    """Return Europe/Berlin ISO time with an explicit CET/CEST UTC offset."""
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamp must include a timezone")
    return value.astimezone(BERLIN).isoformat(timespec="seconds")


def _mos_numeric(raw: str | None, conversion: str) -> float | int | None:
    if raw is None or raw.strip() in {"", "-", "-999", "-999.0"}:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    if not math.isfinite(value):
        return None
    if conversion == "kelvin_to_celsius":
        value -= 273.15
    elif conversion == "ms_to_kmh":
        value *= 3.6
    elif conversion == "pa_to_hpa":
        value /= 100
    return int(value) if conversion == "identity" and value.is_integer() else round(value, 2)


def parse_mosmix_kmz(payload: bytes, retrieved_at: datetime, *, max_age_hours: int = MOSMIX_MAX_AGE_HOURS) -> dict[str, Any]:
    """Parse a DWD MOSMIX-L single-point KMZ without external entity expansion."""
    if retrieved_at.tzinfo is None or retrieved_at.utcoffset() is None:
        raise ValueError("retrieved_at must include a timezone")
    if not payload or len(payload) > MAX_ARCHIVE_BYTES:
        raise DwdSourceError("MOSMIX KMZ is empty or over the size limit")
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            files = [m for m in archive.infolist() if not m.is_dir()]
            if len(files) > MAX_ZIP_MEMBERS:
                raise DwdSourceError("MOSMIX archive has too many files")
            kmls = [m for m in files if m.filename.lower().endswith(".kml")]
            if len(kmls) != 1 or kmls[0].file_size > MAX_XML_BYTES:
                raise DwdSourceError("MOSMIX archive must contain one bounded KML file")
            xml = archive.read(kmls[0])
    except (zipfile.BadZipFile, OSError, RuntimeError) as exc:
        raise DwdSourceError("MOSMIX KMZ could not be read") from exc
    if b"<!DOCTYPE" in xml.upper() or b"<!ENTITY" in xml.upper():
        raise DwdSourceError("MOSMIX KML with DTD or entity declarations is rejected")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise DwdSourceError("MOSMIX KML is malformed") from exc
    issue_text = next((e.text for e in root.iter() if _local(e.tag) == "IssueTime"), None)
    try:
        issued = datetime.fromisoformat((issue_text or "").replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError as exc:
        raise DwdSourceError("MOSMIX IssueTime is missing or invalid") from exc
    step_container = next((e for e in root.iter() if _local(e.tag) == "ForecastTimeSteps"), None)
    times: list[datetime] = []
    if step_container is not None:
        for e in step_container:
            if _local(e.tag) == "TimeStep" and e.text:
                try:
                    times.append(datetime.fromisoformat(e.text.replace("Z", "+00:00")).astimezone(timezone.utc))
                except ValueError:
                    times.append(None)  # retained as index placeholder for aligned value arrays
    placemark = next((p for p in root.iter() if _local(p.tag) == "Placemark" and any(_local(n.tag) == "name" and n.text == "P0043" for n in p)), None)
    if placemark is None or not times:
        raise DwdSourceError("MOSMIX P0043 or forecast time steps are missing")
    coord_text = next((e.text for e in placemark.iter() if _local(e.tag) == "coordinates"), None)
    try:
        lon, lat, *_ = [float(v) for v in (coord_text or "").strip().split(",")]
    except (ValueError, TypeError) as exc:
        raise DwdSourceError("MOSMIX point coordinates are invalid") from exc
    desc = next((e.text for e in placemark if _local(e.tag) == "description"), "")
    raw_params: dict[str, list[str]] = {}
    for forecast in (e for e in placemark.iter() if _local(e.tag) == "Forecast"):
        element_name = next((v for k, v in forecast.attrib.items() if k.endswith("elementName")), None)
        if element_name not in MOSMIX_PARAMS:
            continue
        value = next((e.text for e in forecast if _local(e.tag) == "value"), "") or ""
        raw_params[element_name] = value.split()
    points = []
    for index, valid_at in enumerate(times):
        if valid_at is None:
            continue
        values = {}
        for source_name, (target_name, conversion) in MOSMIX_PARAMS.items():
            series = raw_params.get(source_name, [])
            value = _mos_numeric(series[index] if index < len(series) else None, conversion)
            if value is not None:
                values[target_name] = value
        if "weatherCode" in values:
            values["weatherSymbol"] = weather_symbol(values["weatherCode"])
        points.append({"validAt": utc_iso(valid_at), "validAtLocal": local_iso(valid_at), "values": values})
    age_hours = (retrieved_at.astimezone(timezone.utc) - issued).total_seconds() / 3600
    if age_hours < 0:
        status, reason = "error", "MOSMIX issue time is in the future"
    elif age_hours > max_age_hours:
        status, reason = "stale", f"MOSMIX run is older than {max_age_hours} hours"
    else:
        status, reason = "ok", "latest DWD MOSMIX-L run within freshness limit"
    models = []
    for model in (e for e in root.iter() if _local(e.tag) == "Model"):
        attrs = {_local(k): v for k, v in model.attrib.items()}
        if attrs.get("name"):
            models.append({"name": attrs["name"], "referenceTime": attrs.get("referenceTime")})
    return {
        "provider": "Deutscher Wetterdienst (DWD), MOSMIX-L", "status": status, "statusReason": reason,
        "stationId": "P0043", "stationName": desc or "DWD forecast point P0043",
        "coordinates": {"latitude": lat, "longitude": lon}, "distanceKm": 17.34,
        "issuedAt": utc_iso(issued), "issuedAtLocal": local_iso(issued),
        "retrievedAt": utc_iso(retrieved_at), "retrievedAtLocal": local_iso(retrieved_at),
        "ageHours": round(max(age_hours, 0), 2),
        "models": models, "points": points,
        "source": {"url": MOSMIX_URL, "license": "DWD Open Data; CC BY 4.0 attribution applies"},
    }


def fetch_bytes(url: str, *, timeout: float = 25, max_bytes: int = MAX_ARCHIVE_BYTES) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "lhh-data-hub-dwd-weather/0.2", "Cache-Control": "no-cache"})
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


def build_snapshot(retrieved_at: datetime, payloads: dict[str, bytes | Exception], mosmix_payload: bytes | Exception | None) -> dict[str, Any]:
    observations: dict[str, Any] = {}
    for key in PRODUCTS:
        try:
            item = payloads[key]
            if isinstance(item, Exception):
                raise item
            observations[key] = parse_cdc_product(item, retrieved_at, key=key)
        except Exception as exc:
            observations[key] = {
                "status": "error", "statusReason": str(exc)[:240],
                "station": PRODUCTS[key]["station"], "product": PRODUCTS[key]["product"],
                "measuredAt": None, "measuredAtLocal": None,
                "retrievedAt": utc_iso(retrieved_at), "retrievedAtLocal": local_iso(retrieved_at),
                "ageMinutes": None, "freshnessThresholdMinutes": FRESHNESS_MINUTES,
                "qualityLevel": None, "units": PRODUCTS[key]["units"],
                "values": {name: None for name in PRODUCTS[key]["columns"]},
                "source": {"provider": "DWD Climate Data Center (CDC)", "url": PRODUCTS[key]["url"], "license": "CC BY 4.0"},
            }
    try:
        if isinstance(mosmix_payload, Exception):
            raise mosmix_payload
        forecast = parse_mosmix_kmz(mosmix_payload or b"", retrieved_at)
    except Exception as exc:
        forecast = {"provider": "Deutscher Wetterdienst (DWD), MOSMIX-L", "status": "error", "statusReason": str(exc)[:240], "stationId": "P0043", "issuedAt": None, "issuedAtLocal": None, "retrievedAt": utc_iso(retrieved_at), "retrievedAtLocal": local_iso(retrieved_at), "points": [], "source": {"url": MOSMIX_URL}}
    statuses = [x["status"] for x in observations.values()]
    if all(s == "error" for s in statuses) and forecast["status"] == "error":
        status = "error"
    elif any(s in {"partial", "stale", "error"} for s in statuses) or forecast["status"] != "ok":
        status = "partial"
    else:
        status = "ok"
    return {"schemaVersion": 2, "location": LOCATION, "status": status,
            "observations": observations, "forecast": forecast,
            "lastAttemptAt": utc_iso(retrieved_at),
            "sourceNote": "Messwerte und MOSMIX-Prognosen sind getrennt. Fehlende Werte bleiben null; CDC-now-Daten sind noch nicht abschließend qualitätsgesichert."}


def run(output: Path, *, now: datetime | None = None) -> dict[str, Any]:
    retrieved = now or datetime.now(timezone.utc)
    payloads: dict[str, bytes | Exception] = {}
    fetched: dict[str, bytes | Exception] = {}
    for key, spec in PRODUCTS.items():
        if spec["url"] not in fetched:
            try:
                fetched[spec["url"]] = fetch_bytes(spec["url"])
            except Exception as exc:
                fetched[spec["url"]] = exc
        payloads[key] = fetched[spec["url"]]
    try:
        mos_payload: bytes | Exception = fetch_bytes(MOSMIX_URL)
    except Exception as exc:
        mos_payload = exc
    snapshot = build_snapshot(retrieved, payloads, mos_payload)
    output.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(output, snapshot)
    return snapshot


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("data/generated/weather-dwd.json"))
    args = parser.parse_args()
    snapshot = run(args.output)
    print(f"DWD weather bundle: status={snapshot['status']} forecast={snapshot['forecast']['status']}")
    if snapshot["status"] == "error":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
