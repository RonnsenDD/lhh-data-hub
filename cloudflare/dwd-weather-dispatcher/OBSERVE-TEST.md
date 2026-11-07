# Cron-only Observe test (prepared, not deployed)

## Configuration

The isolated configuration is `wrangler.observe-test.jsonc`:

- Worker: `lhh-dwd-dispatcher-observe-test`
- Entry point: `src/worker.js`
- Mode: `observe`; `WEATHER_DISPATCH_ENABLED=false`
- Cron: `8,23,38,53 * * * *` UTC (four runs/hour, 96/day; matches the handler's eligibility guard)
- `workers_dev=false`, `preview_urls=false`, and no `route`/`routes`
- No `fetch` handler, bindings, storage, GitHub authentication, or secrets

Cloudflare Cron invokes the `scheduled()` handler; the code has no HTTP handler. Cloudflare documents `workers_dev=false` for disabling the workers.dev route, while `preview_urls=false` separately disables version/preview URLs. No route is declared. These settings must be verified on the created Worker after any future approved deployment; they are currently only prepared in this file. Deploying the file would create the worker and activate its Cron, so do not deploy before separate approval.

The base `wrangler.jsonc` is inert: mode disabled, dispatch gate false, no Cron, no routes, and public URLs disabled. Use the named Observe config only after explicit activation approval.

## Read-only behavior and fail-closed cases

Each eligible scheduled invocation makes one anonymous GET for the public DWD sidecar and one anonymous GET for the public `update-dwd-weather.yml` workflow-run history. It does not send Authorization, create a token, POST, dispatch, publish, write to SharePoint, or access persistent storage. HTTP failures, timeouts, malformed data and missing/invalid timestamps produce a no-dispatch error decision; there are no retry loops.

The structured decision log contains UTC decision time, measured-data age, MOSMIX age, last successful workflow start, latest workflow creation/start times, latest run status/event, count of queued/running workflows, hypothetical decision/reason and error status. It omits headers, response bodies, credentials, and secrets. No database is required; Cloudflare observability is the temporary operational record. Logs are not a durable audit archive.

## Free-plan budget estimate

The live read-only inventory on 2026-11-05 found three Workers and two active Cron expressions:

| Existing Worker | Cron |
| --- | --- |
| `feuerwehr-lauchhammer-watchdog` | `*/5 * * * *` |
| `feuerwehr-lauchhammer-watchdog-cpu-test` | `*/30 * * * *` |
| `feuerwehr-lauchhammer-pegel-pilot` | none |

If separately deployed, the new trigger would raise the active Cron count from 2 to 3. Cloudflare documents Free limits of five Cron triggers per account, 10 ms CPU per Cron invocation, 100,000 requests/day, and 50 external subrequests per invocation. At this schedule, this worker would run 96 times/day, use 96 scheduled invocations, and make approximately 192 outbound requests/day (2/run), or 2 of the 50 external subrequests per invocation. The call volume is comfortably below those published ceilings. It is an estimate, not a Cloudflare CPU measurement. The account's actual subscription/remaining allowance is not independently exposed by the connected API; verify the Cloudflare dashboard before deployment despite the Free plan supplied in the task.

Workers Logs currently includes 200,000 events/day and three-day retention on Free; one invocation event plus one structured decision log would be about 192 events/day. Cloudflare announces a shared Observability pricing model effective 2026-12-01. Before a test that crosses that date, verify the then-current Free allowance and account usage. Traces are disabled. Analytics/Observability CPU telemetry, rather than local Node CPU, must be used for Cloudflare CPU p50/p90/p95/max.

GitHub documents a 60 requests/hour unauthenticated limit for REST requests. One workflow-history GET per 15-minute check is four requests/hour from this Worker, but shared egress, secondary limits, or other requests can still produce 403/429. The implementation fails closed and does not retry.

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [workers.dev routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), [Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/), [Workers Logs pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

## Local verification

```sh
node --check src/worker.js
node --test tests/worker.test.mjs tests/cpu-test-worker.test.mjs
```

Wrangler is not currently available in the local environment. The earlier `wrangler dev` attempt was blocked because Wrangler was not installed and npm registry DNS was unavailable. No `wrangler dev --remote`, preview, deploy, or live Cron test has been performed. Node timings/profile are local process measurements only and do not prove the 10 ms Cloudflare Cron limit.

## 24-hour acceptance after a separately approved activation

1. Recheck the actual account plan, Workers usage, current observability terms, and the exact config/commit.
2. Receive separate approval to deploy this one Worker and activate its Cron. Do not change any existing Worker or schedule.
3. Confirm in Cloudflare: exactly the named Worker was created; no routes, workers.dev, Preview/version URL, secrets, bindings, or storage exist; Cron equals `8,23,38,53 * * * *`; mode is `observe`; dispatch gate is false.
4. Observe for at least 24 hours (96 scheduled points). Reconcile scheduled points, Cloudflare outcomes, source-data age, GitHub run state, hypothetical decisions, 403/429 and other errors, and CPU percentiles. Zero dispatches are required. Stop if the route/URL, mode, gate, cost, or CPU condition is unexpected.
5. Preserve the existing two Cron schedules. For rollback, remove only this test Worker or its Cron after separate authorization, then verify the two existing schedules remain unchanged.

This preparation does not constitute a Cloudflare deployment, Cron activation, live sidecar/API test, or proof of long-term reliability.
