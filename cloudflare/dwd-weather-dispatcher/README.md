# DWD weather dispatcher — prepared, not deployed

This standalone dispatcher proposal is isolated from the live Watchdog and Pegel pilot. PR #21 remains Draft. No Cloudflare Worker or Cron was created or changed by this PR.

## Safety

- The base `wrangler.jsonc` is inert: mode `disabled`, dispatch gate `false`, no Cron, no route, `workers_dev=false`, and `preview_urls=false`.
- `src/worker.js` exports only `scheduled()`; there is no `fetch()` handler or public control endpoint.
- The separate `wrangler.observe-test.jsonc` is the only config with a Cron and `observe` mode. Deploying that config would activate the Cron. It must not be deployed before separate approval.
- Observe uses anonymous GET requests only for the public DWD sidecar and public GitHub Actions workflow-run history. No GitHub app, token, secret, Authorization header, POST, dispatch, publication, SharePoint write, or persistent storage is used.
- The code's `dispatch` pathway remains fail-closed. It cannot make a write request and returns `dispatch=false`; the tests assert this.
- Unknown, stale, malformed, future-dated, HTTP-error, timeout, and GitHub 403/429 cases fail closed without retries. A successful workflow run is not treated as evidence that the source measurements are current.

## Cron-only Observe config

Worker name: `lhh-dwd-dispatcher-observe-test`  
Cron: `8,23,38,53 * * * *` UTC — four checks per hour, 96/day. This matches the handler's UTC-minute guard and offsets the existing producer's quarter-hour schedule.  
Dispatch gate: `WEATHER_DISPATCH_ENABLED=false`.

The config sets `workers_dev=false`, `preview_urls=false`, declares no routes, and uses an entrypoint with no HTTP handler. Cloudflare documents these URL controls separately: disabling `workers.dev` alone does not necessarily disable Version/Preview URLs, so both flags are explicit. These controls are currently only in source; after a future approved deploy, verify the actual Worker settings show no route or URL.

## Capacity and cost estimate

Read-only inventory on 2026-11-05 found three existing Workers and two active Cron expressions:

| Worker | Cron |
| --- | --- |
| `feuerwehr-lauchhammer-watchdog` | `*/5 * * * *` |
| `feuerwehr-lauchhammer-watchdog-cpu-test` | `*/30 * * * *` |
| `feuerwehr-lauchhammer-pegel-pilot` | none |

If deployed, the Observe Worker would add one Cron expression, taking the inventory from 2 to 3. Cloudflare documents Workers Free ceilings of five Cron triggers/account, 10 ms CPU per Cron invocation, 100,000 requests/day, and 50 external subrequests per invocation. The prepared worker estimates 96 scheduled invocations/day and two external GETs per eligible run (about 192 outbound requests/day). This is below those published ceilings, but no Cloudflare CPU measurement exists. The task identifies the account as Free; the connected API did not expose actual subscription or remaining allowance, so the account owner's dashboard must be checked before deployment.

Workers Logs are currently included on Free at 200,000 events/day and three-day retention; two events per run would be about 192/day. Cloudflare's shared Observability pricing change is announced for 2026-12-01. Check the current Free allowance and account-level usage before any test crossing that date. Traces are disabled. Use Cloudflare Analytics/Observability CPU telemetry for actual p50/p90/p95/max; Node CPU timing is not Cloudflare telemetry.

GitHub's unauthenticated REST primary limit is 60 requests/hour per originating IP. This poller makes four workflow-history API calls/hour in steady state. Shared egress, secondary limits, or other callers could still cause 403/429; the worker makes no retry and records a fail-closed result.

Official references: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [workers.dev routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), [Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/), [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

## Telemetry and 24-hour acceptance

Each scheduled decision logs UTC decision time, measured-data age, MOSMIX age, latest workflow creation/start times, last successful workflow start, workflow status/event, active-run count, hypothetical dispatch decision/reason, and error label. It does not log headers, payloads, tokens, or credentials. Logs have platform retention and are not a durable database.

After separate deployment approval, observe at least 96 scheduled slots over 24 hours. Reconcile expected runs, actual scheduled events, source freshness, workflow status, errors, and CPU. Require zero dispatch attempts, no public route/URL, no CPU-limit failures, and no repeated GitHub 403/429. Continue monitoring beyond one day before claiming reliability. Roll back only the named test worker or its Cron, then verify the existing two schedules remain unchanged.

## Local validation

From this folder:

```sh
node --check src/worker.js
node --test tests/worker.test.mjs tests/cpu-test-worker.test.mjs
```

Wrangler is unavailable in the local environment: it was not installed and npm registry DNS resolution failed. No remote Wrangler execution, deployment, or Cron run was performed. Local Node measurements/profile are explicitly not equivalent to Cloudflare CPU telemetry.

See [OBSERVE-TEST.md](OBSERVE-TEST.md) for the exact configuration review and activation checklist. PR #20 remains separate and unchanged.
