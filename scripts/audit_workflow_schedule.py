#!/usr/bin/env python3
"""Audit schedule gaps and runner queue delay using this repository's Actions API."""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime


def parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("GitHub run timestamp is missing a timezone")
    return parsed


def audit(current: dict, runs: list[dict], *, interval_minutes: int,
          max_gap_minutes: int, max_queue_delay_minutes: int) -> tuple[list[str], list[str]]:
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
    if current.get("event") != "schedule":
        problems.append("current run is not an automatic schedule event")
    if queue_delay > max_queue_delay_minutes:
        problems.append(
            f"runner queue delay {queue_delay:.1f}m exceeds {max_queue_delay_minutes}m"
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

    successful = [item for item in prior if item[1].get("conclusion") == "success"]
    if successful:
        last_ok_time, last_ok = successful[0]
        messages.append(
            f"last_successful_schedule_run={last_ok.get('id')} "
            f"created_at={last_ok_time.isoformat()} conclusion=success"
        )
    else:
        messages.append("last_successful_schedule_run=none in returned history")

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
        interval = int(os.environ["SCHEDULE_INTERVAL_MINUTES"])
        max_gap = int(os.environ["MAX_SCHEDULE_GAP_MINUTES"])
        max_queue = int(os.environ.get("MAX_QUEUE_DELAY_MINUTES", "5"))
        encoded_workflow = urllib.parse.quote(workflow, safe="/")
        api = "https://api.github.com/repos/" + repository
        current = github_json(f"{api}/actions/runs/{run_id}", token)
        history = github_json(
            f"{api}/actions/workflows/{encoded_workflow}/runs?event=schedule&per_page=100",
            token,
        )
        problems, messages = audit(
            current, history.get("workflow_runs", []),
            interval_minutes=interval,
            max_gap_minutes=max_gap,
            max_queue_delay_minutes=max_queue,
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
