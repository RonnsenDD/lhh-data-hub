# DWD weather dispatcher (prepared, not deployed)

This folder is an isolated, standalone Cloudflare Worker proposal for `RonnsenDD/lhh-data-hub`. It is separate from PR #20. Nothing here changes the current Watchdog, the CPU-test Worker, the Pegel pilot, the GitHub producer workflow, or public data.

## Safety state

- `WEATHER_DISPATCH_MODE` defaults to `disabled`; disabled performs **zero** fetches.
- `observe` fetches the public DWD sidecar and reads only the `update-dwd-weather.yml` Actions history. It never calls `workflow_dispatch`.
- `dispatch` is recognized as a separate, future mode, but remains fail-closed. The implementation deliberately refuses a dispatch with `atomic-dispatch-lock-not-configured`. There is no approved atomic cross-invocation lock, and GitHub concurrency alone can queue duplicate manual runs. Do not treat this branch as dispatch-ready.
- There is no `fetch` handler or public administrative endpoint.
- The repository/App scope is hard-coded to `RonnsenDD/lhh-data-hub`; the token request narrows both repository and Actions permission. `derivedAt`, `retrievedAt`, `lastSuccessfulAt`, and `snapshotPublishedAt` do not substitute for source measurement/model times.
- Request errors are reduced to bounded status labels. JWTs, tokens, private keys, authorization headers and bodies are never logged.

## Schedule and expected quota use

The proposed Cron is `8,23,38,53 * * * *` (96 decisions/day), five minutes after the producer's scheduled `:03/:18/:33/:48` times. Its purpose is to observe a missed producer opportunity after the scheduled start. It is only in the local Wrangler configuration; no trigger has been created.

The current live inventory read found these schedules:

| Existing Worker | Cron |
| --- | --- |
| `feuerwehr-lauchhammer-watchdog` | `*/5 * * * *` |
| `feuerwehr-lauchhammer-watchdog-cpu-test` | `*/30 * * * *` |
| `feuerwehr-lauchhammer-pegel-pilot` | none |

A separately deployed dispatcher would add a third schedule. Planning uses the Workers Free documented ceilings: 5 Cron Triggers per account, 10 ms CPU per Cron invocation, 100,000 requests/day and 50 external subrequests per invocation. The proposed observe invocation makes at most three external requests (public sidecar, short-lived installation-token exchange, one workflow-runs query): 288/day if all 96 checks run. This is below the documented request/subrequest ceilings, but is not a measured live usage result and does not confirm the actual account tariff. The Cloudflare API did not provide billing-plan details through this connection. Workers Logs currently includes 200,000 events/day and 3-day retention on Free; with invocation and decision logging this worker would produce about 192 events/day. On December 1, 2026, Cloudflare will move existing Workers Observability customers to shared observability pricing (Free: 0.5 GB/day ingestion and 7-day retention; Paid: 50 GB/month ingestion and 10 GB-month storage included). Account-level remaining allowances are not visible here, so plan and usage must be checked again before any deployment after that change.

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## Data decision rules

1. Accept only the expected DWD v2 sidecar source and valid RFC3339 source timestamps.
2. Compute weather age from each original observation `measuredAt`; existing declared limits are capped at 60 minutes.
3. Compute MOSMIX age from original `issuedAt`; the existing 12-hour limit is a hard cap. Check `hasUsablePoint` and `validThrough` separately.
4. Ignore `derivedAt` and retrieval/publication timestamps for freshness. Null `lastSuccessfulAt` and `snapshotPublishedAt` remain null and are not synthesized.
5. Unknown statuses, missing or future source times, malformed JSON, HTTP errors and GitHub API failures all fail closed. A GitHub run is not proof that published source data is current.
6. An eligible observation sees queued/running jobs and any workflow start younger than 20 minutes as a stop condition. A recent publication attempt is another stop condition. Only a stale original source state with older-than-cooldown attempt/run history can become `wouldDispatch` in Observe.
7. Dispatch is additionally stopped until a safe atomic lock and a separately approved dispatch design exist. No exactly-once claim is made.

## Modes and configuration

`wrangler.jsonc` pins `WEATHER_DISPATCH_MODE="disabled"` and `WEATHER_DISPATCH_ENABLED="false"`. The proposed schedule and Worker name are configuration only. Do not deploy this config without separate authorization.

For an eventual Observe deployment, the separate Worker would need its own app bindings. Existing Cloudflare secrets are Worker-scoped: read-only settings inspection found `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, and a redacted `GITHUB_APP_PRIVATE_KEY` binding on the existing Watchdog, but no such binding on the CPU-test Worker. No private key value was read. The new Worker does not inherit the Watchdog secret. App ID/installation ID are non-secret variables; the key must be manually entered as a Cloudflare secret after deployment approval. Current GitHub App installation is repository-restricted and has Actions read only. Observe requires `Actions: read`; future dispatch would need repository-scoped `Actions: write` and separate approval. No permission change is requested.

## Local tests and CPU measurements

```sh
node --test tests/worker.test.mjs
node tests/benchmark.mjs
```

The benchmark uses Node.js `process.cpuUsage()` and reports component-level percentiles for JSON parse, source-time evaluation, RSA token signing/token mock, and combined observe evaluation. The current Node 24.21.0 run measured JSON parse p50/p95 0.001/0.003 ms (5,000 runs), freshness+decision p50/p95 0.003/0.005 ms (10,000), RSA+mock token p50/p95 0.594/0.997 ms (100), and combined CPU components p50/p95 0.574/0.787 ms (500). Outlier maxima reached 13.659 ms in the RSA microbenchmark; garbage collection and process scheduling affect these figures. It is only a local comparison; it is **not** Cloudflare CPU telemetry and cannot prove the 10 ms Cron limit. Initial isolate startup is also not represented by the in-process Node benchmark.

The local Python suite found in the available October export (which has no `.git` metadata and is not the current GitHub `main`) also passed 63 tests. This is not a rerun of PR #20’s current 131-test suite; the prior PR report states those 131 passed. A fresh clone attempt was blocked by unavailable DNS/network, so current-main Python tests could not be independently rerun. A real Cloudflare CPU result would require a separately approved deployment of this isolated Worker, then a full 24-hour Observe period and read-only Cloudflare analytics. The prior live Workers showed watchdog p50 13.524 ms/p95 26.128 ms and CPU-test p50 6.407 ms/p95 11.934 ms (rolling 24h at the previous check); these are other Workers, not a measurement of this dispatcher. The standalone dispatch path is not authorized or enabled.

## 24-hour Observe acceptance

After account-plan/cost verification and explicit deployment approval:

- Preserve both existing schedules and deploy only the named standalone Worker.
- Keep dispatch `disabled`; use Observe only. Never configure `WEATHER_DISPATCH_ENABLED=true`.
- Collect 96 planned checks and compare UTC decision, source age, last workflow start/event/status, decision/reason, failure label and Cloudflare CPU.
- Acceptance: at least 92/96 decision logs, zero dispatch requests, zero CPU-limit errors, no credential strings in logs, and a manual review of each stale-data or missed-schedule case. This does not prove long-term reliability; continue monitoring.
- Roll back by setting mode to `disabled` or deleting only the separately deployed test Worker after explicit approval. Do not change existing producer or Watchdog schedules.

## PR #20

PR #20 remains separate and unchanged: open Draft, head `80acdd306beeed8f590f28f81837937e2f80e24e`, reported mergeable against `main` at base `ec51ac169889acbf954565e2bad720cd2499d4df`. This dispatcher branch must not be combined with its MOSMIX fallback changes.
