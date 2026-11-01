#!/usr/bin/env python3
"""Validate the compact DWD weather freshness sidecar without network access."""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any


STATUSES = {"ok", "partial", "stale", "error", "unavailable"}
OBSERVATION_KEYS = {
    "temperatureHumidity",
    "stationPressure",
    "wind",
    "windGust",
    "precipitation",
}


def _instant(value: Any, field: str, *, nullable: bool = True) -> datetime | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{field} must be an ISO-8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{field} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{field} must include a timezone")
    return parsed


def validate_manifest(document: Any, *, require_usable_valid_times: bool = False) -> None:
    if not isinstance(document, dict) or document.get("schemaVersion") != 1:
        raise ValueError("expected DWD freshness sidecar schemaVersion 1")
    if document.get("source") != "DWD weather snapshot v2":
        raise ValueError("source must identify DWD weather snapshot v2")
    if document.get("sourceStatus") not in STATUSES:
        raise ValueError("sourceStatus is missing or unsupported")
    for name in ("lastAttemptAt", "lastSuccessfulAt", "snapshotPublishedAt", "derivedAt"):
        if name not in document:
            raise ValueError(f"{name} is required")
        _instant(document[name], name, nullable=name != "derivedAt")

    observations = document.get("observations")
    if not isinstance(observations, dict) or not OBSERVATION_KEYS.issubset(observations):
        raise ValueError("observations is missing required products")
    for name in OBSERVATION_KEYS:
        item = observations[name]
        if not isinstance(item, dict) or item.get("status") not in STATUSES:
            raise ValueError(f"observations.{name}.status is missing or unsupported")
        _instant(item.get("measuredAt"), f"observations.{name}.measuredAt")
        _instant(item.get("retrievedAt"), f"observations.{name}.retrievedAt")
        threshold = item.get("freshnessThresholdMinutes")
        if threshold is not None and (isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or threshold < 0):
            raise ValueError(f"observations.{name}.freshnessThresholdMinutes must be non-negative or null")
        fields = item.get("availableFields")
        if not isinstance(fields, list) or any(not isinstance(field, str) for field in fields):
            raise ValueError(f"observations.{name}.availableFields must be a string array")

    forecast = document.get("forecast")
    if not isinstance(forecast, dict) or forecast.get("status") not in STATUSES:
        raise ValueError("forecast.status is missing or unsupported")
    for name in ("issuedAt", "retrievedAt", "validAt", "validThrough"):
        _instant(forecast.get(name), f"forecast.{name}")
    has_usable = forecast.get("hasUsablePoint")
    if not isinstance(has_usable, bool):
        raise ValueError("forecast.hasUsablePoint must be boolean")

    if "usableValidTimes" not in forecast:
        if require_usable_valid_times:
            raise ValueError("forecast.usableValidTimes is required for new publications")
        if has_usable != (forecast.get("validAt") is not None):
            raise ValueError("legacy forecast.hasUsablePoint contradicts validAt")
        return

    values = forecast["usableValidTimes"]
    if not isinstance(values, list):
        raise ValueError("forecast.usableValidTimes must be an array")
    instants = [_instant(value, f"forecast.usableValidTimes[{index}]", nullable=False) for index, value in enumerate(values)]
    if instants != sorted(set(instants)):
        raise ValueError("forecast.usableValidTimes must be unique and chronologically ordered")
    if has_usable != bool(values):
        raise ValueError("forecast.hasUsablePoint contradicts usableValidTimes")
    expected_next = values[0] if values else None
    if forecast.get("validAt") != expected_next:
        raise ValueError("forecast.validAt must equal the first usableValidTimes entry")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--require-usable-valid-times", action="store_true")
    args = parser.parse_args()
    try:
        document = json.loads(args.manifest.read_text(encoding="utf-8"))
        validate_manifest(document, require_usable_valid_times=args.require_usable_valid_times)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"DWD freshness sidecar validation failed: {exc}")
        return 1
    print("DWD freshness sidecar validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
