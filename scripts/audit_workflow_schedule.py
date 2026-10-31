#!/usr/bin/env python3
"""Audit schedule gaps and runner queue delay using this repository's Actions API."""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, time, timezone


def parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("GitHub run timestamp is missing a timezone")
    return parsed


def audit(current: dict, runs: list[dict], *, interval_minutes: int,
          max_gap_minutes: int, max_queue_delay_minutes: int,
          producer_job_name: str, current_producer_result: str,
          prior_producer_results: dict[str, str],
          expected_schedule_time_utc: str | None = None,
          max_schedule_start_delay_minutes: int = 60) -> tuple[list[str], list[str]]:
    problems: list[str] = []
    messages: list[str] = []
    current_created = parse_time(current["created_at"])
    current_started = parse_time(current["run_started_at"])
    queue_delay = max(0.0, (current_started - current_created).total_seconds() / 60)
    messages.append(
        f"current_run={current.get('id')} event={current.get('event')} "
        f"created_at={current_created.isoformat()} started_at={current_started.isoformat()} "
        f"queue_delay_minutes={queue_delay:.1f}"
    )
    messages.append(
        f"producer_job={producer_job_name} current_producer_result={current_producer_result} "
        f"workflow_run_conclusion={current.get('conclusion') or 'in_progress'}"
    )
    if current.get("event") != "schedule":
        problems.append("current run is not an automatic schedule event")
    if queue_delay > max_queue_delay_minutes:
        problems.append(
            f"runner queue delay {queue_delay:.1f}m exceeds {max_queue_delay_minutes}m"
        )

    if current.get("event") == "schedule" and expected_schedule_time_utc:
        try:
            expected_time = time.fromisoformat(expected_schedule_time_utc)
        except ValueError as error:
            raise ValueError("expected schedule time must use HH:MM UTC") from error
        if expected_time.second or expected_time.microsecond:
            raise ValueError("expected schedule time must use HH:MM UTC")
        current_created_utc = current_created.astimezone(timezone.utc)
        scheduled_slot = datetime.combine(
            current_created_utc.date(), expected_time, tzinfo=timezone.utc
        )
        start_delay = (current_created_utc - scheduled_slot).total_seconds() / 60
        messages.append(
            f"expected_schedule_slot_utc={scheduled_slot.isoformat()} "
            f"run_created_at_utc={current_created_utc.isoformat()} "
            f"schedule_start_delay_minutes={start_delay:.1f}"
        )
        if start_delay > max_schedule_start_delay_minutes:
            problems.append(
                f"schedule start delay {start_delay:.1f}m exceeds "
                f"{max_schedule_start_delay_minutes}m after expected UTC slot"
            )

    prior = []
    for run in runs:
        if str(run.get("id")) == str(current.get("id")):
            continue
        if run.get("event") != "schedule" or not run.get("created_at"):
            continue
        created = parse_time(run["created_at"])
        if created < current_created:
            prior.append((created, run))
    prior.sort(key=lambda item: item[0], reverse=True)

    successful_producers = [
        item for item in prior
        if prior_producer_results.get(str(item[1].get("id"))) == "success"
    ]
    if successful_producers:
        last_ok_time, last_ok = successful_producers[0]
        messages.append(
            f"last_successful_producer_run={last_ok.get('id')} "
            f"created_at={last_ok_time.isoformat()} producer_job={producer_job_name} "
            f"producer_result=success workflow_run_conclusion={last_ok.get('conclusion')}"
        )
    else:
        messages.append("last_successful_producer_run=none in returned history")

    if not prior:
        messages.append("schedule_gap=baseline unavailable; no earlier scheduled run returned")
        return problems, messages

    previous_time, previous = prior[0]
    gap = (current_created - previous_time).total_seconds() / 60
    messages.append(
        f"previous_schedule_run={previous.get('id')} conclusion={previous.get('conclusion')} "
        f"created_at={previous_time.isoformat()} gap_minutes={gap:.1f} "
        f"expected_interval_minutes={interval_minutes}"
    )
    if gap > max_gap_minutes:
        problems.append(
            f"schedule gap {gap:.1f}m exceeds allowed {max_gap_minutes}m "
            f"(interval {interval_minutes}m plus grace)"
        )
    return problems, messages


def github_json(url: str, token: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "lhh-data-hub-schedule-audit",
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status != 200:
            raise RuntimeError(f"GitHub API returned HTTP {response.status}")
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    try:
        token = os.environ["GITHUB_TOKEN"]
        repository = os.environ["GITHUB_REPOSITORY"]
        run_id = os.environ["GITHUB_RUN_ID"]
        workflow = os.environ["WORKFLOW_FILE"]
        producer_job_name = os.environ["PRODUCER_JOB_NAME"]
        current_producer_result = os.environ["PRODUCER_JOB_RESULT"]
        interval = int(os.environ["SCHEDULE_INTERVAL_MINUTES"])
        max_gap = int(os.environ["MAX_SCHEDULE_GAP_MINUTES"])
        max_queue = int(os.environ.get("MAX_QUEUE_DELAY_MINUTES", "5"))
        expected_schedule_time = os.environ.get("EXPECTED_SCHEDULE_TIME_UTC")
        max_start_delay = int(os.environ.get("MAX_SCHEDULE_START_DELAY_MINUTES", "60"))
        encoded_workflow = urllib.parse.quote(workflow, safe="/")
        api = "https://api.github.com/repos/" + repository
        current = github_json(f"{api}/actions/runs/{run_id}", token)
        history = github_json(
            f"{api}/actions/workflows/{encoded_workflow}/runs?event=schedule&per_page=100",
            token,
        )
        runs = history.get("workflow_runs", [])
        current_created = parse_time(current["created_at"])
        producer_results: dict[str, str] = {}
        prior_scheduled = sorted(
            (run for run in runs
             if run.get("event") == "schedule"
             and run.get("created_at")
             and parse_time(run["created_at"]) < current_created),
            key=lambda run: parse_time(run["created_at"]),
            reverse=True,
        )
        for run in prior_scheduled:
            run_id_value = str(run.get("id"))
            if run.get("conclusion") == "success":
                producer_results[run_id_value] = "success"
            else:
                jobs = github_json(
                    f"{api}/actions/runs/{run_id_value}/jobs?per_page=100", token
                ).get("jobs", [])
                producer_job = next(
                    (job for job in jobs if job.get("name") == producer_job_name), None
                )
                producer_results[run_id_value] = (
                    producer_job.get("conclusion") or producer_job.get("status") or "unknown"
                    if producer_job else "unknown"
                )
            if producer_results[run_id_value] == "success":
                break
        problems, messages = audit(
            current, runs,
            interval_minutes=interval,
            max_gap_minutes=max_gap,
            max_queue_delay_minutes=max_queue,
            producer_job_name=producer_job_name,
            current_producer_result=current_producer_result,
            prior_producer_results=producer_results,
            expected_schedule_time_utc=expected_schedule_time,
            max_schedule_start_delay_minutes=max_start_delay,
        )
    except (KeyError, ValueError, RuntimeError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        print(f"schedule audit unavailable: {error}", file=sys.stderr)
        return 1

    for message in messages:
        print(message)
    if problems:
        for problem in problems:
            print(f"schedule audit failure: {problem}", file=sys.stderr)
        return 1
    print("schedule audit passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
