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

Scheduled runs now log their expected UTC slot and actual GitHub run start. A delay above five minutes is a failed operational check for 15-minute sources; the daily grassland run uses a 30-minute budget. The check is skipped for manual dispatches. It does not mask or rewrite source timestamps. This catches late starts only when a run exists; a wholly missing event remains visible as a gap in Actions history and in source freshness.

## Main-branch publication concurrency

Weather, levels, and grassland are independent data fetches and now have per-source concurrency groups. They no longer hold a shared lock while downloading unrelated upstream data. Their writes still target the same `main` branch, so each producer uses `scripts/publish_one_snapshot.sh` for a bounded, non-force publication:

- allowlisted output paths only;
- fetch latest `main` before publishing;
- rebase on unrelated commits and retry a bounded number of times;
- abort if the same generated file changed remotely, rather than overwrite it.

The radar workflow publishes a Pages artifact and keeps its separate Pages concurrency group; it does not write to `main`.

The publication helper serializes successful branch updates through Git's fast-forward push. Parallel source runs may fetch concurrently. If two same-source runs race on one output, one aborts safely and is visible as a failed run; there is no silent last-writer overwrite.

## Monitoring and missed runs

On each actual run, inspect both the GitHub run event/conclusion and the source timestamps above. A recent workflow completion only proves a recent attempt; it does not make an old upstream measurement fresh. Stale/error values remain marked as such, and workflow validation rejects technically invalid snapshots. Per-source timestamps and computed ages remain in the generated JSON and are included by each producer's fetch/validation logs; use those alongside the run conclusion.

A missing schedule event cannot be detected by the producer workflow when no job starts. The public repository's Actions run history is therefore the authoritative current audit for missed starts. A separate external watchdog could poll the GitHub Actions API and compare the last scheduled completion with the expected schedule, then alert or dispatch the same existing workflow. It would require a private, minimum-scope credential with permission only to read workflow runs and dispatch these workflows. No secret, worker, external scheduler, monitor workflow, or new workflow was added here.

## If native scheduling keeps missing

GitHub's schedule remains best-effort; changing cron offsets is mitigation only. A cost-neutral fallback candidate is one Cloudflare Workers Free cron trigger used solely to invoke the existing GitHub workflow-dispatch API (not to fetch or publish data). For a 15-minute interval that is 96 invocations/day, far below the published Workers Free request limit, but the dispatcher still depends on GitHub Actions availability and does not supply a delivery SLA. The Worker would need a narrowly scoped GitHub token stored as an encrypted secret, HTTPS-only API calls, repository/workflow allowlists, timestamp/nonce checks, rate limiting, and failure logging. Account eligibility/limits and the token's minimum permission must be confirmed before approval. No such service or credential is configured by this change.

## Verification after merge

Do not treat manual runs as schedule proof. Record at least two separate `event=schedule` successes per workflow, together with publication commit/deployment time and source timestamps. Continue to report schedule gaps as gaps; do not refresh or rewrite source timestamps to make the feed appear current.
