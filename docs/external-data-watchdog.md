# External watchdog (prepared, not deployed)

This folder prepares a Cloudflare Workers watchdog for the four existing public producers. It is deliberately inactive until an administrator approves account setup and deployment. It does not modify the existing producer workflows or dashboard consumers.

## What it checks

Every tick inspects (a) GitHub Actions run history, (b) the named producer job rather than the overall workflow conclusion, (c) public JSON/manifests, (d) publication timestamps where available, and (e) source/product timestamps. It reports one of:

- `aktuell`
- `veraltet`
- `Abruf fehlgeschlagen`
- `Automatik ausgefallen`

The JSON log record includes source age, latest schedule run, latest producer run, publication time(s), separate schedule-audit result, and any dispatch result. A GitHub dispatch acknowledgement is never presented as a successful data refresh. There is no public status endpoint; the worker's fallback fetch handler returns 404, `workers_dev` is disabled, and the latest report is held in the private Durable Object storage and operator logs.

Thresholds follow current producer contracts and reliability documentation:

| Source | Existing workflow/job | Schedule gap threshold | Data-age rule | Dispatch cooldown |
| --- | --- | ---: | --- | ---: |
| Weather | `update-dwd-weather.yml` / `update-weather` | 20 min | each observation's own threshold (default 60 min), MOSMIX issue time max 12 h; publication age max 45 min | 60 min |
| Levels (both stations) | `update-levels.yml` / `update` | 20 min | each `measuredAtUtc` max 45 min; publication age max 45 min | 60 min |
| RADOLAN-RY + KONRAD3D | `update-radolan-ry.yml` / `publish` | 20 min | `productTime` / `referenceTime` max 15 min; check `publishedAt` max 45 min and checked separately | 60 min |
| Grassland fire index | `update-graslandfeuerindex.yml` / `update` | 25 h | DWD `dataAsOf` max 36 h and `today.date` must be today's date in Europe/Berlin; publication age max 30 h | 6 h |

If both schedule automation and payload freshness are healthy, state is `aktuell`. A stale source is never made fresh based on retrieval/publication time. A producer job failure maps to `Abruf fehlgeschlagen`; audit-only failures remain separately visible. When the schedule is overdue, status is `Automatik ausgefallen` unless a producer run is already active (active runs always suppress dispatch). A broken GitHub API/permission is reported as `Abruf fehlgeschlagen` and never causes an unverified dispatch.

## Dispatch safety

Only the four hard-coded existing workflow files can be dispatched, always on `main`, using the existing `workflow_dispatch` trigger. The watchdog never accepts a workflow name, branch, or arbitrary URL from an HTTP caller.

- A singleton Durable Object serializes ticks.
- Any queued or in-progress run blocks another dispatch.
- A persisted per-source cooldown is written **before** sending the dispatch request, so a timeout after GitHub accepts a request cannot cause a retry loop.
- Cooldown: one hour for the 15-minute products; six hours for the daily GLFI feed.
- GitHub's 204 dispatch response is only recorded as `requested`; a later workflow run, producer job result, publication time, and source age must independently establish success.
- API, parsing, or feed failures are logged without response bodies or secrets.
- No automatic repeated retry occurs within the cooldown.

The watcher's checks are sequential and limited to the four fixed workflows and their fixed public feeds. No loop polls GitHub rapidly.

## Cost and alternative comparison

Cloudflare Workers Free is a plausible first candidate for a 15-minute best-effort watchdog: the current plan documents 100,000 Worker requests/day, 10 ms CPU per invocation, and up to five Cron Triggers per account. The configured Cron uses one trigger and produces about 96 invocations/day. The singleton Durable Object is also intended to stay inside its published Free quotas. Exceeding Free quotas causes limits/failed operations rather than authorizing paid service; this design does not enable Paid, set billing, or use a paid resource. Plan quotas and availability must be rechecked in the user's Cloudflare account at approval time. Free-tier service has no operational SLA and does not make schedule delivery guaranteed.

Power Automate can be included with some Microsoft 365 licenses for scheduled flows and standard connectors (the owner's exact entitlement/action quota must be checked). Microsoft's standard GitHub connector documents `Create a repository dispatch event`, but not the Actions `workflow_dispatch` endpoint needed here. Adding `repository_dispatch` to the four producer workflows would change them and is outside this PR. Calling GitHub's REST dispatch endpoint through the Power Automate HTTP connector requires a Premium connector; therefore Power Automate is not confirmed as a no-additional-cost implementation under the requested restrictions. Existing tenant licensing may cover Premium, but must be verified before use.

## Cost and alternative comparison

Cloudflare Workers Free is a plausible first candidate for a 15-minute best-effort watchdog: the current plan documents 100,000 Worker requests/day, 10 ms CPU per invocation, and up to five Cron Triggers per account. The configured Cron uses one trigger and produces about 96 invocations/day. The singleton Durable Object is also intended to stay inside its published Free quotas. Exceeding Free quotas causes limits/failed operations rather than authorizing paid service; this design does not enable Paid, billing, or a paid resource. The Workers Paid plan has a US list minimum of $5/month; it is explicitly excluded. Plan quotas and availability must be rechecked in the user's Cloudflare account at approval time. Free-tier service has no operational SLA and does not make schedule delivery guaranteed.

Power Automate can be included with some Microsoft 365 licenses for scheduled flows and standard connectors; the exact tenant entitlement and owner's action quota must be checked. The standard GitHub connector is classed Standard and documents a `Create a repository dispatch event` action, but the current producer workflows only expose `workflow_dispatch`. Using repository_dispatch would require changing those workflows and is outside this PR. Calling GitHub's REST `workflow_dispatch` endpoint through the Power Automate HTTP connector requires Premium. Microsoft's US list price for Power Automate Premium is $15/user/month paid yearly (regional pricing/tax and any existing tenant entitlement vary). Therefore Power Automate is not confirmed as a no-additional-cost implementation under the requested restrictions; it is only cost-neutral if an eligible Premium entitlement already exists, or if a different approved mechanism is identified.

## Exact setup required later (not done by this PR)

1. Review and merge this code PR first. No Worker or secret is created by merge.
2. An administrator verifies Cloudflare Workers Free availability/quotas in the account and explicitly approves creating/deploying the Worker. Do not activate a paid plan, billing cap, or paid add-on.
3. Create a fine-grained GitHub token restricted to repository `RonnsenDD/lhh-data-hub`, with only Actions: read/write and Contents: read (repository metadata read is implicit). Set an expiration and owner. This token is required because the watchdog reads Actions runs/jobs, reads publication commit dates, and dispatches only the fixed workflows.
4. Store the token as the Worker secret `GITHUB_TOKEN` using Cloudflare's secret binding mechanism (for example `wrangler secret put GITHUB_TOKEN`). Never put it in Git, Wrangler vars, shell command history, public JSON, or logs. No token is generated or stored by this PR.
5. Deploy from the repository using the root config `wrangler.watchdog.jsonc`, and verify the account exposes no route/worker-dev hostname. Confirm Cron Trigger appears once per quarter hour and inspect JSON logs. No deployment is performed here.
6. Rollback is to disable/delete this Worker Cron Trigger and revoke the fine-grained token. This does not alter producer workflows or data publication.

## Local tests

Run with Node.js 20+:

```sh
node --test tools/watchdog/watchdog.test.mjs
```

Tests cover a missing schedule, stale source timestamps despite `status: ok`, GitHub API failure, active run duplicate prevention, dispatch acknowledgement versus actual refresh, audit-vs-producer result, and cooldown suppression. Tests use only mocked fetch and in-memory storage; no network or secret is used.
