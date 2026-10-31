#!/usr/bin/env python3
"""Kostebrau WeeWX + DWD ICON snapshot, compatible with the legacy weather feed."""
from __future__ import annotations

import argparse
import html
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

STATION_URL = "https://wetter.lausitzlink.de/"
MODEL_URL = "https://api.open-meteo.com/v1/dwd-icon"
LAT, LON = 51.527833, 13.831333
BERLIN = ZoneInfo("Europe/Berlin")
MAX_AGE_MINUTES = 45
MAX_BYTES = 2_000_000
WEATHER = {
    0: ("Klar", "☀️"), 1: ("Heiter", "🌤️"), 2: ("Teilweise bewölkt", "⛅"),
    3: ("Bewölkt", "☁️"), 45: ("Nebel", "🌫️"), 48: ("Nebel", "🌫️"),
    51: ("Leichter Nieselregen", "🌦️"), 53: ("Nieselregen", "🌦️"),
    55: ("Starker Nieselregen", "🌧️"), 56: ("Gefrierender Nieselregen", "🌧️"),
    57: ("Starker gefrierender Nieselregen", "🌧️"), 61: ("Leichter Regen", "🌧️"),
    63: ("Regen", "🌧️"), 65: ("Starker Regen", "🌧️"), 66: ("Leichter gefrierender Regen", "🌧️"),
    67: ("Starker gefrierender Regen", "🌧️"), 71: ("Leichter Schneefall", "❄️"),
    73: ("Schneefall", "❄️"), 75: ("Starker Schneefall", "❄️"), 77: ("Schneekörner", "🌨️"),
    80: ("Leichte Regenschauer", "🌦️"), 81: ("Regenschauer", "🌧️"), 82: ("Starke Regenschauer", "🌧️"),
    85: ("Leichte Schneeschauer", "🌨️"), 86: ("Starke Schneeschauer", "🌨️"),
    95: ("Gewitter", "⛈️"), 96: ("Gewitter mit Hagel", "⛈️"), 99: ("Starkes Gewitter mit Hagel", "⛈️"),
}


class SourceError(RuntimeError):
    pass


def parse_station(raw: str) -> dict:
    text = re.sub(r"(?is)<script\b.*?</script>|<style\b.*?</style>|<[^>]+>", " ", raw)
    text = re.sub(r"\s+", " ", html.unescape(text)).strip()

    def get(pattern):
        match = re.search(pattern, text, re.I | re.S)
        return match.group(1).strip() if match else None

    def num(value):
        try:
            result = float(value.replace(",", ".")) if value is not None else None
            return result if result is not None and math.isfinite(result) else None
        except ValueError:
            return None

    measured = get(r"(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2})")
    temperature = num(get(r"Außentemperatur\s+(-?\d+[,.]\d+)\s*°C"))
    humidity = get(r"Luftfeuchte\s+(\d+)\s*%")
    pressure = num(get(r"Luftdruck\s+(\d+[,.]\d+)\s*mbar"))
    wind = re.search(r"Windgeschwindigkeit\s+([0-9]+(?:[,.][0-9]+)?)\s*km/h\s*([A-Za-zÄÖÜäöüß]+)", text, re.I)
    gust = re.search(r"Böen\s+Geschwindigkeit\s+([0-9]+(?:[,.][0-9]+)?)\s*km/h\s*([A-Za-zÄÖÜäöüß]+)", text, re.I)
    values = {
        "measuredAt": measured, "temperatureC": temperature,
        "humidityPercent": int(humidity) if humidity else None, "pressureHpa": pressure,
        "windKmh": num(wind.group(1)) if wind else None, "windDirection": wind.group(2).upper() if wind else None,
        "gustKmh": num(gust.group(1)) if gust else None, "gustDirection": gust.group(2).upper() if gust else None,
        "rainTotalCm": num(get(r"Regen\s+([0-9]+(?:[,.][0-9]+)?)\s*cm\s+Gesamt")),
        "rainRateCmH": num(get(r"Regen-Rate\s+([0-9]+(?:[,.][0-9]+)?)\s*cm/h")),
        "maxRainRateCmH": num(get(r"Max Regen-Rate\s+([0-9]+(?:[,.][0-9]+)?)\s*cm/h")),
    }
    missing = [key for key, value in values.items() if value is None]
    if missing:
        raise SourceError("Required Kostebrau fields missing: " + ", ".join(missing))
    if not 0 <= values["humidityPercent"] <= 100:
        raise SourceError("Kostebrau humidity outside 0..100")
    try:
        wall = datetime.strptime(measured, "%d.%m.%Y %H:%M:%S")
    except ValueError as exc:
        raise SourceError("Invalid Kostebrau measurement time") from exc
    candidates = []
    for fold in (0, 1):
        value = wall.replace(tzinfo=BERLIN, fold=fold)
        if value.astimezone(timezone.utc).astimezone(BERLIN).replace(tzinfo=None) == wall:
            candidates.append(value)
    if not candidates:
        raise SourceError("Kostebrau time is nonexistent in Europe/Berlin")
    ambiguous = len({value.utcoffset() for value in candidates}) > 1
    values["measuredAt"] = wall.isoformat(timespec="seconds")
    values["measuredAtUtc"] = None if ambiguous else candidates[0].astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    values["timestampAmbiguous"] = ambiguous
    return values


def parse_model(payload: bytes) -> dict:
    try:
        current = json.loads(payload.decode("utf-8")).get("current")
        code = current.get("weather_code")
    except (UnicodeDecodeError, json.JSONDecodeError, AttributeError) as exc:
        raise SourceError("Invalid DWD ICON/Open-Meteo response") from exc
    if isinstance(code, bool) or not isinstance(code, (int, float)) or not math.isfinite(code) or int(code) != code:
        raise SourceError("Missing DWD ICON weather_code")
    description, icon = WEATHER.get(int(code), ("Wetterlage unbekannt", "🌡️"))
    is_day = current.get("is_day")
    return {
        "code": int(code), "description": description, "icon": icon,
        "isDay": is_day if is_day in (0, 1) else None,
        "provider": "DWD ICON via Open-Meteo", "modelMeasuredAt": current.get("time"),
    }


def build_snapshot(station_html: str, model_json: bytes, now: datetime) -> dict:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must have a timezone")
    station = parse_station(station_html)
    now_utc = now.astimezone(timezone.utc)
    ambiguous = station["timestampAmbiguous"]
    measured_utc = datetime.fromisoformat(station["measuredAtUtc"].replace("Z", "+00:00")) if station["measuredAtUtc"] else None
    if ambiguous:
        age_minutes = None
        status, reason = "stale", "Messzeit liegt in der doppeldeutigen Europe/Berlin-Stunde."
    else:
        age_minutes = round((now_utc - measured_utc).total_seconds() / 60, 1)
        if age_minutes < -5:
            raise SourceError("Kostebrau measurement is in the future")
        status = "stale" if age_minutes > MAX_AGE_MINUTES else "ok"
        reason = "Messzeit älter als 45 Minuten" if status == "stale" else "Messzeit innerhalb der Frischegrenze"
    retrieved = now_utc.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return {
        "location": {"name": "Kostebrau, Lauchhammer", "city": "Lauchhammer", "latitude": LAT, "longitude": LON},
        "station": {"name": "DB0LS, Kostebrau", "id": "DB0LS", "software": "WeeWX", "hardware": "WS1080"},
        "source": {"provider": "Wetterstation Kostebrau / Lausitzlink", "url": STATION_URL},
        "weather": parse_model(model_json),
        "measuredAt": station["measuredAt"], "measuredAtTimezone": "Europe/Berlin",
        "measuredAtUtc": station["measuredAtUtc"], "timestampAmbiguous": ambiguous,
        "retrievedAt": retrieved, "lastAttemptAt": retrieved, "lastSuccessfulAt": retrieved,
        "ageMinutes": age_minutes, "freshnessThresholdMinutes": MAX_AGE_MINUTES,
        **{k: v for k, v in station.items() if k not in {"measuredAt", "measuredAtUtc", "timestampAmbiguous"}},
        "status": status, "statusReason": reason,
    }


def fetch(url: str, timeout: int = 30) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "Lagezentrum-Lauchhammer/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status != 200:
                raise SourceError(f"HTTP {response.status} from {url}")
            payload = response.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as exc:
        raise SourceError(f"HTTP {exc.code} from source") from exc
    except SourceError:
        raise
    except Exception as exc:
        raise SourceError(f"Fetch failed for {url}: {type(exc).__name__}") from exc
    if not payload or len(payload) > MAX_BYTES:
        raise SourceError(f"Empty or oversized response from {url}")
    return payload


def run(output: Path, timeout: int = 30) -> dict:
    station = fetch(STATION_URL, timeout).decode("utf-8", errors="replace")
    query = urllib.parse.urlencode({"latitude": LAT, "longitude": LON, "current": "weather_code,is_day", "timezone": "Europe/Berlin"})
    model = fetch(f"{MODEL_URL}?{query}", timeout)
    result = build_snapshot(station, model, datetime.now(timezone.utc))
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=output.parent, delete=False) as handle:
        temp = Path(handle.name)
        json.dump(result, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(temp, output)
    print(f"status={result['status']} measuredAt={result['measuredAt']} {result['measuredAtTimezone']} retrievedAt={result['retrievedAt']} ageMinutes={result['ageMinutes']}")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("data/generated/kostebrau-weather.json"))
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args()
    if not 1 <= args.timeout <= 120:
        parser.error("--timeout must be between 1 and 120")
    run(args.output, args.timeout)


if __name__ == "__main__":
    main()
