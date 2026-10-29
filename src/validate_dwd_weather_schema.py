#!/usr/bin/env python3
"""Dependency-free validator for the DWD weather JSON Schema subset and publication contract."""
from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse


def _type_ok(value: Any, expected: str) -> bool:
    if expected == "object": return isinstance(value, dict)
    if expected == "array": return isinstance(value, list)
    if expected == "string": return isinstance(value, str)
    if expected == "integer": return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number": return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    if expected == "boolean": return isinstance(value, bool)
    if expected == "null": return value is None
    return False


def _validate(value: Any, rule: dict[str, Any], root: dict[str, Any], path: str) -> list[str]:
    errors: list[str] = []
    if "$ref" in rule:
        ref = rule["$ref"]
        if not ref.startswith("#/"):
            return [f"{path}: remote schema references are unsupported"]
        target: Any = root
        for component in ref[2:].split("/"):
            target = target[component.replace("~1", "/").replace("~0", "~")]
        return _validate(value, target, root, path)
    types = rule.get("type")
    if types is not None:
        accepted = [types] if isinstance(types, str) else types
        if not any(_type_ok(value, item) for item in accepted):
            return [f"{path}: expected type {accepted}"]
    if "const" in rule and value != rule["const"]:
        errors.append(f"{path}: expected constant {rule['const']!r}")
    if "enum" in rule and value not in rule["enum"]:
        errors.append(f"{path}: value is outside the allowed enum")
    if isinstance(value, dict):
        missing = [key for key in rule.get("required", []) if key not in value]
        errors.extend(f"{path}: missing required property {key}" for key in missing)
        props = rule.get("properties", {})
        for key, child in value.items():
            if key in props:
                errors.extend(_validate(child, props[key], root, f"{path}.{key}"))
            elif rule.get("additionalProperties") is False:
                errors.append(f"{path}: unexpected property {key}")
            elif isinstance(rule.get("additionalProperties"), dict):
                errors.extend(_validate(child, rule["additionalProperties"], root, f"{path}.{key}"))
    if isinstance(value, list) and isinstance(rule.get("items"), dict):
        for index, child in enumerate(value):
            errors.extend(_validate(child, rule["items"], root, f"{path}[{index}]"))
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in rule and value < rule["minimum"]:
            errors.append(f"{path}: below minimum {rule['minimum']}")
        if "maximum" in rule and value > rule["maximum"]:
            errors.append(f"{path}: above maximum {rule['maximum']}")
    if rule.get("format") == "date-time" and value is not None:
        try:
            parse_timestamp(value)
        except (TypeError, ValueError):
            errors.append(f"{path}: expected ISO 8601 date-time with timezone")
    return errors


def parse_timestamp(value: Any) -> datetime:
    if not isinstance(value, str):
        raise TypeError("timestamp must be a string")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("timestamp must include timezone")
    return parsed.astimezone(timezone.utc)


def validate(instance: Any, schema: dict[str, Any]) -> list[str]:
    """Validate the schema keywords used by this feed, including local refs."""
    return _validate(instance, schema, schema, "$")


def validate_publication(instance: Any, schema: dict[str, Any], *, now: datetime | None = None,
                         max_attempt_age_minutes: int = 45) -> list[str]:
    """Reject malformed, stale-attempt, un-attributed or technically failed snapshots."""
    errors = validate(instance, schema)
    if errors or not isinstance(instance, dict):
        return errors
    now_utc = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    try:
        attempted = parse_timestamp(instance.get("lastAttemptAt"))
    except (TypeError, ValueError):
        return ["$.lastAttemptAt: invalid or missing timestamp"]
    attempt_age = (now_utc - attempted).total_seconds() / 60
    if attempt_age < -5:
        errors.append("$.lastAttemptAt: timestamp is unexpectedly in the future")
    elif attempt_age > max_attempt_age_minutes:
        errors.append(f"$.lastAttemptAt: attempt is older than {max_attempt_age_minutes} minutes")

    root_status = instance.get("status")
    if root_status == "error":
        errors.append("$.status: technical error snapshots cannot be published")
    observations = instance.get("observations", {})
    allowed_stations = {
        "temperatureHumidity": ("02627", "Schipkau-Klettwitz"),
        "precipitation": ("02627", "Schipkau-Klettwitz"),
        "stationPressure": ("01001", "Doberlug-Kirchhain"),
        "wind": ("01001", "Doberlug-Kirchhain"),
        "windGust": ("01001", "Doberlug-Kirchhain"),
    }
    substatuses: list[str] = []
    for key, expected in allowed_stations.items():
        obs = observations.get(key, {})
        status = obs.get("status")
        substatuses.append(status)
        prefix = f"$.observations.{key}"
        if status == "error":
            errors.append(f"{prefix}.status: technical source errors cannot be published")
        elif status not in ("ok", "partial", "stale"):
            errors.append(f"{prefix}.status: invalid publication status")
        station = obs.get("station", {})
        if (station.get("id"), station.get("name")) != expected:
            errors.append(f"{prefix}.station: unexpected station mapping")
        source = obs.get("source", {})
        _check_source(errors, prefix, source, provider="DWD Climate Data Center (CDC)", require_cc_by=True)
        try:
            retrieved = parse_timestamp(obs.get("retrievedAt"))
            measured_value = obs.get("measuredAt")
            measured = parse_timestamp(measured_value) if measured_value is not None else None
            if retrieved > attempted:
                errors.append(f"{prefix}.retrievedAt: later than lastAttemptAt")
            if measured is not None and measured > retrieved:
                errors.append(f"{prefix}.measuredAt: later than retrievedAt")
            age = obs.get("ageMinutes")
            threshold = obs.get("freshnessThresholdMinutes")
            if measured is not None and isinstance(age, (int, float)) and not isinstance(age, bool):
                actual_age = (retrieved - measured).total_seconds() / 60
                if abs(actual_age - age) > 2:
                    errors.append(f"{prefix}.ageMinutes: inconsistent with measuredAt and retrievedAt")
                if status == "ok" and actual_age > threshold:
                    errors.append(f"{prefix}.status: ok contradicts the freshness threshold")
                if status == "stale" and actual_age <= threshold:
                    errors.append(f"{prefix}.status: stale contradicts the freshness threshold")
        except (TypeError, ValueError):
            errors.append(f"{prefix}: invalid source timestamp")

    forecast = instance.get("forecast", {})
    forecast_status = forecast.get("status")
    substatuses.append(forecast_status)
    if forecast_status == "error":
        errors.append("$.forecast.status: technical forecast errors cannot be published")
    elif forecast_status not in ("ok", "stale"):
        errors.append("$.forecast.status: invalid publication status")
    if forecast.get("provider") != "Deutscher Wetterdienst (DWD), MOSMIX-L":
        errors.append("$.forecast.provider: unexpected source")
    if forecast.get("stationId") != "P0043":
        errors.append("$.forecast.stationId: unexpected forecast point")
    # The forecast provider is recorded at forecast.provider; current v2 data
    # carries URL/license (but no duplicate provider) in forecast.source.
    _check_source(errors, "$.forecast", forecast.get("source", {}),
                  provider=None, require_cc_by=True)
    try:
        retrieved = parse_timestamp(forecast.get("retrievedAt"))
        issued_value = forecast.get("issuedAt")
        issued = parse_timestamp(issued_value) if issued_value is not None else None
        if retrieved > attempted:
            errors.append("$.forecast.retrievedAt: later than lastAttemptAt")
        if issued is not None and issued > retrieved:
            errors.append("$.forecast.issuedAt: later than retrievedAt")
        age_hours = forecast.get("ageHours")
        if issued is not None and isinstance(age_hours, (int, float)) and not isinstance(age_hours, bool):
            actual_age = (retrieved - issued).total_seconds() / 3600
            if abs(actual_age - age_hours) > 0.1:
                errors.append("$.forecast.ageHours: inconsistent with issuedAt and retrievedAt")
            if forecast_status == "ok" and actual_age > 12:
                errors.append("$.forecast.status: ok contradicts the 12-hour freshness threshold")
            if forecast_status == "stale" and actual_age <= 12:
                errors.append("$.forecast.status: stale contradicts the 12-hour freshness threshold")
    except (TypeError, ValueError):
        errors.append("$.forecast: invalid issue/retrieval timestamp")

    if root_status == "ok" and any(status != "ok" for status in substatuses):
        errors.append("$.status: ok contradicts a stale/partial source status")
    if root_status == "partial" and all(status == "ok" for status in substatuses):
        errors.append("$.status: partial has no partial/stale subsource")
    return errors


def _check_source(errors: list[str], prefix: str, source: Any, *, provider: Optional[str], require_cc_by: bool) -> None:
    if not isinstance(source, dict):
        errors.append(f"{prefix}.source: missing source metadata")
        return
    if provider is not None and source.get("provider") != provider:
        errors.append(f"{prefix}.source.provider: unexpected source provider")
    parsed = urlparse(str(source.get("url", "")))
    if parsed.scheme != "https" or parsed.hostname != "opendata.dwd.de":
        errors.append(f"{prefix}.source.url: expected an HTTPS official DWD Open Data URL")
    license_text = str(source.get("license", ""))
    if require_cc_by and "CC BY 4.0" not in license_text:
        errors.append(f"{prefix}.source.license: DWD CC BY 4.0 attribution missing")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data", type=Path)
    parser.add_argument("--schema", type=Path, default=Path("docs/dwd-weather-v2.schema.json"))
    parser.add_argument("--for-publication", action="store_true", help="enforce source, status and freshness publication checks")
    parser.add_argument("--max-attempt-age-minutes", type=int, default=45,
                        help="maximum age of lastAttemptAt for publication (default: 45)")
    args = parser.parse_args()
    schema = json.loads(args.schema.read_text(encoding="utf-8"))
    instance = json.loads(args.data.read_text(encoding="utf-8"))
    errors = (validate_publication(instance, schema, max_attempt_age_minutes=args.max_attempt_age_minutes)
              if args.for_publication else validate(instance, schema))
    if errors:
        raise SystemExit("\n".join(errors))
    print(f"Valid: {args.data} conforms to {args.schema}" + (" and publication contract" if args.for_publication else ""))


if __name__ == "__main__":
    main()
