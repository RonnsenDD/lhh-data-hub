#!/usr/bin/env python3
"""Report and bound GitHub Actions schedule start delay; never touches feed data."""
from __future__ import annotations

import argparse
from datetime import date, datetime, time, timedelta, timezone


def parse_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("run start must include a timezone")
    return parsed.astimezone(timezone.utc)


def latest_cron_slot(started: datetime, minutes: list[int]) -> datetime:
    if not minutes or any(minute < 0 or minute > 59 for minute in minutes):
        raise ValueError("cron minutes must be a non-empty list from 0 to 59")
    candidates = [
        datetime.combine((started - timedelta(days=1)).date(), time(hour, minute), timezone.utc)
        for hour in range(24)
        for minute in minutes
    ]
    candidates.extend(
        datetime.combine(started.date(), time(hour, minute), timezone.utc)
        for hour in range(24)
        for minute in minutes
    )
    due = [candidate for candidate in candidates if candidate <= started]
    if not due:
        raise ValueError("could not determine the previous scheduled slot")
    return max(due)


def latest_daily_slot(started: datetime, scheduled_time: time) -> datetime:
    candidates = [
        datetime.combine(started.date() - timedelta(days=offset), scheduled_time, timezone.utc)
        for offset in (0, 1)
    ]
    due = [candidate for candidate in candidates if candidate <= started]
    return max(due)


def evaluate(started: datetime, expected: datetime, max_delay_minutes: int) -> tuple[float, bool]:
    delay_minutes = max(0.0, (started - expected).total_seconds() / 60)
    return delay_minutes, delay_minutes <= max_delay_minutes


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-started-at", required=True, help="GitHub run_started_at ISO timestamp")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--cron-minutes", help="Comma-separated UTC minute offsets, e.g. 3,18,33,48")
    group.add_argument("--daily-time", help="Daily UTC time HH:MM")
    parser.add_argument("--max-delay-minutes", type=int, required=True)
    args = parser.parse_args()

    try:
        started = parse_utc(args.run_started_at)
        if args.max_delay_minutes < 0:
            raise ValueError("max delay must not be negative")
        if args.cron_minutes:
            minutes = [int(value.strip()) for value in args.cron_minutes.split(",")]
            expected = latest_cron_slot(started, minutes)
        else:
            hour_text, minute_text = args.daily_time.split(":", 1)
            scheduled_time = time(int(hour_text), int(minute_text), tzinfo=timezone.utc)
            expected = latest_daily_slot(started, scheduled_time)
        delay, within_limit = evaluate(started, expected, args.max_delay_minutes)
    except (ValueError, TypeError) as error:
        parser.error(str(error))

    print(
        f"schedule_expected_at={expected.isoformat().replace('+00:00', 'Z')} "
        f"run_started_at={started.isoformat().replace('+00:00', 'Z')} "
        f"start_delay_minutes={delay:.1f} allowed_delay_minutes={args.max_delay_minutes}"
    )
    if not within_limit:
        print("Scheduled workflow started too late; source freshness must be evaluated separately.")
        return 1
    print("Scheduled workflow start was within the configured delay budget.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
