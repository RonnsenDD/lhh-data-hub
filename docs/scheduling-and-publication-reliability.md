# Scheduling and publication reliability

This document records the operational contract for the four active scheduled producers in `lhh-data-hub`. Scheduled runs are best-effort: a missed run is an operational gap, not a successful refresh.

## Current schedules (UTC)

| Producer | Workflow | Cron | Publication | Source freshness evidence |
| --- | --- | --- | --- | --- |
| DWD weather | `.github/workflows/update-dwd-weather.yml` | `3,18,33,48 * * * *` | `data/generated/dwd-weather.json` on `main` | `lastAttemptAt`; each observation's `measuredAt`, `ageMinutes`, `freshnessThresholdMinutes`, and `status`; forecast `issuedAt` and `ageHours` |
| Pegel (Lauchhammer, Biehlen 1) | `.github/workflows/update-levels.yml` | `11,26,41,56 * * * *` | Both gauge JSON files on `main` | Per-file `lastAttemptAt`, `latestMeasurement.measuredAtUtc`, `ageMinutes`, `freshnessThresholdMinutes`, `status` |
| RADOLAN-RY + KONRAD3D | `.github/workflows/update-radolan-ry.yml` | `7,22,37,52 * * * *` | One combined GitHub Pages artifact | RADOLAN `productTime`, `retrievedAt`, `status`; KONRAD3D `referenceTime`, retrieval metadata, `status` |
| DWD Graslandfeuerindex | `.github/workflows/update-graslandfeuerindex.yml` | `15 5 * * *` | `data/generated/graslandfeuerindex.json` on `main` | `lastAttemptAt`, `lastSuccessfulAt`, `today.date`, `status`, `statusReason` |

The weather and gauge schedules were shifted away from minute 00 because GitHub documents that scheduled events can be delayed during high load, especially at the start of each hour, and may be dropped under sufficiently high load. The feed cadence is unchanged. Radar was already offset; the daily grassland schedule is already away from the hour boundary. These offsets reduce a known pressure point; they do not prove that GitHub caused prior gaps or guarantee schedule delivery.

## Main-branch publication concurrency

Weather, levels, and grassland are independent data fetches and now have per-source concurrency groups. They no longer hold a shared lock while downloading unrelated upstream data. Their writes still target the same `main` branch, so each producer uses `scripts/publish_one_snapshot.sh` for a bounded, non-force publication:

- allowlisted output paths only;
- fetch latest `main` before publishing;
- rebase on unrelated commits and retry a bounded number of times;
- abort if the same generated file changed remotely, rather than overwrite it.

The radar workflow publishes a Pages artifact and keeps its separate Pages concurrency group; it does not write to `main`.

The publication helper serializes successful branch updates through Git's fast-forward push. Parallel source runs may fetch concurrently. If two same-source runs race on one output, one aborts safely and is visible as a failed run; there is no silent last-writer overwrite.

## Monitoring and missed runs

Each automatic run queries the same workflow's Actions history using the run-scoped built-in `GITHUB_TOKEN` with only `actions:read`. It records the most recent successful scheduled run, the previous schedule event, the event gap, and runner queue delay. For 15-minute producers, a gap above 20 minutes or queue delay above 5 minutes fails the operational check; the daily GLFI thresholds are 25 hours and 60 minutes. Manual dispatches are excluded. Per-source timestamps and computed ages remain in the generated JSON and fetch/validation logs: a recent workflow completion only proves a recent attempt, not a fresh upstream measurement. No source timestamp is rewritten.

This detects a missed or delayed interval when a later run starts; it cannot alert during a period where no workflow starts at all. GitHub does not include a definitive scheduled-for timestamp in the schedule event. A fully independent watchdog would poll Actions history from outside Actions and alert or dispatch the same existing workflow. No external service or credential was configured here; the in-workflow audit uses only GitHub's short-lived built-in token with read-only Actions permission.

## If native scheduling keeps missing

GitHub's schedule remains best-effort; changing cron offsets is mitigation only. A missed/late run must be evidenced from Actions history, and stale source data must remain visibly stale in its JSON status. A cost-neutral fallback candidate is one Cloudflare Workers Free cron trigger used solely to invoke the existing GitHub workflow-dispatch API (not to fetch or publish data). For a 15-minute interval that is 96 invocations/day, far below the published Workers Free request limit, but the dispatcher still depends on GitHub Actions availability and does not supply a delivery SLA. The Worker would need a narrowly scoped GitHub token stored as an encrypted secret, HTTPS-only API calls, repository/workflow allowlists, timestamp/nonce checks, rate limiting, and failure logging. Account eligibility/limits and the token's minimum permission must be confirmed before approval. This PR does not set it up.

## Verification after merge

Do not treat manual runs as schedule proof. Record at least two separate `event=schedule` successes per workflow, together with publication commit/deployment time and source timestamps. Continue to report schedule gaps as gaps; do not refresh or rewrite source timestamps to make the feed appear current.
