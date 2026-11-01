#!/usr/bin/env python3
"""Create a small freshness-only sidecar from a validated DWD weather snapshot.

The sidecar carries source timestamps and producer statuses only. It deliberately
does not copy forecast points or measurements; its additive usableValidTimes list
contains timestamps only for validated future points with at least one finite
numeric value. Generated/publication timestamps never substitute for source time.
"""
from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


OBSERVATIONS = {
    "temperatureHumidity": (
        "temperatureC",
        "relativeHumidityPercent",
        "dewPointC",
    ),
    "stationPressure": ("stationPressureHpa",),
    "wind": ("windSpeedKmh", "windDirectionDeg"),
    "windGust": ("windGustKmh",),
    "precipitation": ("precipitation10MinMm",),
}
STATUSES = {"ok", "partial", "stale", "error", "unavailable"}


def _source_status(value: Any, field: str) -> str:
    status = value.get("status") if isinstance(value, dict) else None
    if status not in STATUSES:
        raise ValueError(f"{field}.status is missing or unsupported")
    return status


def _instant(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc) if parsed.tzinfo else None


def create_manifest(snapshot: dict[str, Any], *, derived_at: str | None = None) -> dict[str, Any]:
    if not isinstance(snapshot, dict) or snapshot.get("schemaVersion") != 2:
        raise ValueError("expected DWD weather schemaVersion 2")
    observations = snapshot.get("observations")
    forecast = snapshot.get("forecast")
    if not isinstance(observations, dict) or not isinstance(forecast, dict):
        raise ValueError("observations and forecast must be objects")

    generated_at = derived_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    generated_instant = _instant(generated_at)
    if generated_instant is None:
        raise ValueError("derivedAt must be an ISO-8601 timestamp with timezone")
    compact_observations: dict[str, dict[str, Any]] = {}
    for name, fields in OBSERVATIONS.items():
        item = observations.get(name)
        status = _source_status(item, f"observations.{name}")
        values = item.get("values") if isinstance(item, dict) else None
        values = values if isinstance(values, dict) else {}
        compact_observations[name] = {
            "status": status,
            "measuredAt": item.get("measuredAt"),
            "retrievedAt": item.get("retrievedAt"),
            "freshnessThresholdMinutes": item.get("freshnessThresholdMinutes"),
            "availableFields": [
                field
                for field in fields
                if isinstance(values.get(field), (int, float))
                and math.isfinite(values[field])
                and not isinstance(values[field], bool)
            ],
        }

    forecast_status = _source_status(forecast, "forecast")
    points = forecast.get("points")
    if not isinstance(points, list):
        if forecast_status in {"error", "stale", "unavailable"}:
            points = []
        else:
            raise ValueError("forecast.points must be an array for a usable producer status")
    valid_times: list[tuple[datetime, str]] = []
    usable_times: dict[datetime, str] = {}
    for point in points:
        if not isinstance(point, dict):
            continue
        valid_at = _instant(point.get("validAt"))
        if valid_at is None:
            continue
        valid_times.append((valid_at, point["validAt"]))
        values = point.get("values")
        if valid_at < generated_instant or not isinstance(values, dict):
            continue
        if not any(
            isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
            for value in values.values()
        ):
            continue
        usable_times.setdefault(valid_at, point["validAt"])
    sorted_usable_times = sorted(usable_times.items())
    next_usable = sorted_usable_times[0] if sorted_usable_times else None

    return {
        "schemaVersion": 1,
        "source": "DWD weather snapshot v2",
        "sourceStatus": snapshot.get("status"),
        "lastAttemptAt": snapshot.get("lastAttemptAt"),
        "lastSuccessfulAt": snapshot.get("lastSuccessfulAt"),
        "snapshotPublishedAt": snapshot.get("publishedAt"),
        "derivedAt": generated_at,
        "observations": compact_observations,
        "forecast": {
            "status": forecast_status,
            "issuedAt": forecast.get("issuedAt"),
            "retrievedAt": forecast.get("retrievedAt"),
            "validAt": next_usable[1] if next_usable else None,
            "validThrough": max(valid_times, default=(None, None), key=lambda item: item[0])[0]
            .isoformat(timespec="milliseconds").replace("+00:00", "Z")
            if valid_times else None,
            "hasUsablePoint": next_usable is not None,
            # Additive v1 field: an evaluator can advance past an elapsed next
            # point without inferring data availability from validThrough alone.
            "usableValidTimes": [value for _, value in sorted_usable_times],
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    snapshot = json.loads(args.input.read_text(encoding="utf-8"))
    manifest = create_manifest(snapshot)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
