# Watchdog CPU profiling and repeatable benchmarks

## Current finding (2026-10-31)

Cloudflare dashboard observations supplied for version `2a748e33` were 17 ms, 12 ms, and 16 ms CPU, all with `outcome: ok` and `GITHUB_APP_READ_ENABLED=false`. These are above the documented Workers Free Cron CPU limit of 10 ms, even though these particular invocations completed. Do not treat `outcome: ok` or occasional runtime flexibility as evidence of a reliable margin below the limit.

The current `main` revision inspected was `a639b0f9f2c262e6c0e117894b1dc2952809361a` (after PR #15). The public JSON snapshots available in that revision measured:

| Feed | Sample bytes | Work inspected |
|---|---:|---|
| DWD weather / MOSMIX | 106,200 | 247 forecast points; five observation groups and MOSMIX are both evaluated |
| Pegel Lauchhammer | 13,673 | Latest measurement and history JSON |
| Pegel Biehlen 1 | 13,943 | Latest measurement and history JSON |
| RADOLAN-RY | Not captured in this session | Pages manifest path and status evaluator inspected; use a downloaded snapshot for profiling |
| KONRAD3D | Not captured in this session | Pages manifest path and status evaluator inspected; use a downloaded snapshot for profiling |
| Graslandfeuerindex | 1,221 | Day list and source timestamp |
| Waldbrand OSL | 1,159 | Source date and 08:00 Europe/Berlin validity window |

The RADOLAN and KONRAD3D samples in the benchmark fallback are explicitly schema fixtures, not measured production payloads. The two Pages endpoints must be added to a local snapshot directory before making claims about their real response sizes.

A local Node profile of the available snapshots isolates UTF-8 decode plus `JSON.parse`. It measured approximately 0.126 ms for the 106 KB weather body, 0.015 ms for each 14 KB level body, and about 0.001–0.002 ms for the grassland and wildfire bodies. These are Node process-CPU measurements, not Cloudflare CPU measurements. Parsing those bodies alone therefore does not explain 12–17 ms on the deployed Worker. The authoritative cause remains unproven until a production CPU flamegraph is captured.

Two deterministic redundancies were removed from the handler: `timestamp()` had called `Date.parse` twice for each valid timestamp, and `berlinWallClockToUtc()` constructed the same `Intl.DateTimeFormat` twice per wildfire interval. The formatter is now reused at module scope. Freshness rules, feed URLs, source comparisons, concurrency, and output states are unchanged. A regression test verifies one `Date.parse` call per valid timestamp; the existing DST tests verify the 23/25-hour windows.

## Local profiling

All commands below use public JSON only, mock outbound HTTP where applicable, and do not set `GITHUB_APP_READ_ENABLED=true` unless the existing benchmark's explicit adapter mode is requested. They do not start GitHub workflows.

1. Create a temporary directory outside the repository and save public JSON snapshots as `dwd-weather.json`, `level-l.json`, `level-b.json`, `radar.json`, `konrad.json`, `grass.json`, and `wildfire.json`. The first five JSON files in `data/generated/` can be obtained from the repository's public `raw.githubusercontent.com` URLs; use the two published GitHub Pages URLs already declared in `worker.js` for radar and KONRAD3D. Do not commit these time-sensitive files.
2. Isolate decode and parse cost for each available file:

   ```sh
   WATCHDOG_PROFILE_DIR=/tmp/watchdog-snapshots \
   WATCHDOG_PROFILE_ITERATIONS=15000 \
   node tools/watchdog/profile-feeds.mjs
   ```

   For a per-source Node flamegraph, choose a single feed and run the script with Node's CPU profiler:

   ```sh
   WATCHDOG_PROFILE_DIR=/tmp/watchdog-snapshots \
   WATCHDOG_PROFILE_FEED=weather \
   node --cpu-prof --cpu-prof-dir=/tmp --cpu-prof-name=watchdog-weather.cpuprofile \
   tools/watchdog/profile-feeds.mjs
   ```

   `profile-feeds.mjs` prints only source label, byte count, optional MOSMIX point count, and timing. It never prints JSON payload values.

3. Benchmark the full scheduled path against mocked HTTP responses using the same public snapshots:

   ```sh
   WATCHDOG_BENCH_DIR=/tmp/watchdog-snapshots \
   WATCHDOG_BENCH_ITERATIONS=1000 \
   node tools/watchdog/benchmark.mjs
   ```

   The benchmark reports Node process CPU, median/p95, exact HTTP call counts, and per-feed fixture/snapshot sizes. It has no Cloudflare credentials and its GitHub API calls are mocked. `GITHUB_APP_READ_ENABLED` remains false in the production handler; the benchmark separately exercises its existing mocked enabled case to guard its read-only behavior.

4. Measure module initialization separately:

   ```sh
   node tools/watchdog/profile-startup.mjs
   node --cpu-prof --cpu-prof-dir=/tmp --cpu-prof-name=watchdog-init.cpuprofile \
   tools/watchdog/profile-startup.mjs
   ```

   This includes the local Node ESM loader and is not equivalent to Cloudflare isolate startup.

5. Profile the scheduled handler with the local Workers runtime (Wrangler `--test-scheduled`; no deployed trigger is changed):

   ```sh
   npx wrangler dev --test-scheduled --config wrangler.watchdog.jsonc
   ```

   In a second terminal, send a request to the printed local port at `/cdn-cgi/local/scheduled?format=json`. Open Wrangler DevTools with `D`, use the Profiler tab, and capture the same invocation. The local runtime can use network fetches to the public JSON sources; it does not dispatch Actions. Do not provide a GitHub App key or enable its flag.

## Authoritative Cloudflare profile

Cloudflare documents that `Date.now()` and `performance.now()` in deployed Workers only advance after I/O. They cannot reliably time a synchronous parse/evaluator block in production. Use a CPU flamegraph instead of adding timer logging to the live Worker.

For the already deployed version, in Cloudflare Dashboard open **Workers & Pages → `feuerwehr-lauchhammer-watchdog` → Observability → Flamegraph**, choose **CPU**, choose the active version corresponding to `2a748e33` (or the exact currently active version), and capture a 10–50 second profile. Capture must overlap real activity on an already loaded isolate; a profile is not a replay of historical Cron runs. Align it with a scheduled Cron invocation, or separately exercise the existing read-only `/status` path when profiling the shared feed collection. Do not deploy code or alter Cron settings for this profile. Keep any exported profile in the private operational workspace and do not publish request data or secrets with it.

Cloudflare's production profiler is also available through `cf workers versions profile`; do not store a Cloudflare token in this repository. A capture is a diagnostic operation against a deployed version, not a code deployment. This change does not invoke it because the current tool session could not enumerate the authorized Cloudflare account.

Wrangler `check startup` (Wrangler 4.116.0 or later) can profile module startup and bundle size locally. Startup is a separate question from CPU charged to `scheduled()`; report the two measurements separately.

## Benchmark results for this change

On Node v24.21.0, each of three repetitions used 20 warm-ups and 1,000 scheduled invocations, 136,450 bytes total from five public snapshots plus small RADOLAN/KONRAD3D schema fixtures, mocked network, GitHub App disabled, and no Cloudflare runtime. The table gives the median of the three repeated measurements:

| Version | App disabled: mean | median | p95 |
|---|---:|---:|---:|
| PR #15 baseline | 0.451 ms | 0.383 ms | 0.698 ms |
| This PR | 0.385 ms | 0.326 ms | 0.638 ms |

The local repeated measurements were about 15% lower in mean and 9% lower at p95 after removing redundant date parsing and formatter allocation. Node performance, scheduler noise, fixture state, and mocked responses differ from Cloudflare; these numbers do not establish that the deployed Worker is below 10 ms. Confirm the improvement and locate the remaining 12–17 ms with the production flamegraph before claiming a Free-tier CPU margin.

## Cloudflare references

- CPU time and Free Cron limit: https://developers.cloudflare.com/workers/platform/limits/#cpu-time
- Worker timers and local CPU profiling: https://developers.cloudflare.com/workers/runtime-apis/performance/#performancenow
- Production CPU profiling: https://developers.cloudflare.com/workers/observability/profiling-in-production/
- Local Cron testing: https://developers.cloudflare.com/workers/configuration/cron-triggers/#test-cron-triggers-locally
- Wrangler startup profile: https://developers.cloudflare.com/changelog/post/2026-07-31-wrangler-startup-profile-summary/
