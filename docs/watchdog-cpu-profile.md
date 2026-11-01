# Watchdog CPU profiling and freshness-only Cron path

## Current behavior

The public `GET /` and `GET /status` handlers continue to fetch and evaluate all seven feeds. The existing full weather feed is about 106 KB and contains the observation values plus the complete MOSMIX forecast (the sample reviewed for this change had 247 forecast points). That public result remains the detailed operational status view.

The scheduled dispatch guard only needs the DWD product timestamps/statuses and the two radar product timestamps. It now reads three small inputs: the DWD freshness sidecar, RADOLAN-RY, and KONRAD3D. The weather workflow derives `data/generated/dwd-weather-freshness.json` from the already validated DWD snapshot and publishes both files in the same bounded publisher commit. The sidecar carries no measurement values and no forecast points. Its `derivedAt` and `snapshotPublishedAt` fields are informational only; freshness is calculated from the original observation `measuredAt` fields and MOSMIX `issuedAt`.

The sidecar is generated only after the existing schema/publication validator succeeds. A missing source timestamp remains missing. `status`, measured time, issue time, freshness thresholds, and numeric-field availability are copied from the validated full snapshot. MOSMIX `validAt`/`validThrough` are derived from its real point timestamps. A source timestamp is never replaced with the time the sidecar was generated or published.

## CPU measurement

Set `WATCHDOG_DIAGNOSTICS_ENABLED=true` only during a controlled observation. A scheduled run logs per-feed response bytes, body read duration, UTF-8 decode time, JSON parse time, and synchronous evaluator duration. Those durations are useful component timings, but body read/fetch durations include waiting and are not CPU measurements. Diagnostics are off unless explicitly enabled and never log values, URLs, headers, or credentials.

`node tools/watchdog/benchmark.mjs` measures Node process CPU with mocked outbound HTTP. It is a repeatable comparison tool, not a Cloudflare CPU measurement. Use `WATCHDOG_BENCH_DIR` with a directory containing `dwd-weather.json`, `radar.json`, and `konrad.json` to profile actual public payload sizes; other feeds may be schema fixtures. The output reports median, p90, p95, maximum, process CPU, HTTP-call counts, and synchronous per-component timings. Results must be labeled with Node version and snapshot capture time.

### Local comparison for this PR

Run on Node v24.21.0 with 30 warm-ups, 200 measured iterations, and 100 per-feed diagnostic iterations. The weather input was the public `dwd-weather.json` snapshot fetched for this change (106,184 bytes, 247 MOSMIX points). The sidecar was generated from that snapshot by the new Python helper (1,779 bytes). Radar/KONRAD3D and the other feeds were small schema fixtures; they do not represent their live payload sizes.

| Local collector | Feed requests/run | Input bytes/run | Median CPU | p90 | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Full seven-feed collection | 7 | 108,739 | 0.274 ms | 0.366 ms | 0.470 ms | 1.486 ms |
| Scheduled freshness collection | 3 | 2,033 | 0.025 ms | 0.032 ms | 0.039 ms | 0.513 ms |

The three-feed path used about 98% fewer input bytes and 57% fewer feed requests in this fixture comparison. This is a local Node comparison; it does not predict the same percentage of Cloudflare CPU savings. Per-feed Node profile for the weather input: full JSON decode median/p95 0.016/0.092 ms, JSON parse 0.120/0.144 ms, full weather evaluation 0.025/0.037 ms. For the 1,779-byte sidecar those were 0.0003/0.0016 ms, 0.0027/0.0043 ms, and 0.0038/0.0102 ms. Separate formatting checks measured full status JSON serialization at median/p95 0.004/0.005 ms (4,744 output bytes) and scheduled log formatting at 0.002/0.005 ms (624 bytes). The remaining full public route still evaluates all MOSMIX points; the scheduled route does not.

Additional Node process CPU samples (200 runs each): scheduled with flags off median/p90/p95/max 0.033/0.122/0.247/1.173 ms; stale observe-only 0.031/0.041/0.087/1.013 ms; diagnostics on 0.032/0.048/0.166/0.966 ms; simulated GitHub read-only 0.645/0.800/0.862/1.526 ms with six mocked GitHub API requests per run and zero dispatches. The read-only CPU increase is local RS256 signing and mocked API handling. All outbound HTTP was mocked; no GitHub API or Worker dispatch was performed by the benchmark.

Cloudflare CPU must be read from the deployed Worker’s Cron telemetry. The Cloudflare Free plan documents a 10 ms CPU limit per Cron Trigger invocation: <https://developers.cloudflare.com/workers/platform/limits/>. Account plan/billing status is separate and must be checked in the account. Do not infer Cloudflare CPU from Node timing or from total request wall time.

## Safe evaluation and rollout boundary

No Worker was deployed for this change. The updated handler and editor bundle have only local automated tests and Node benchmarks. The live Worker therefore still runs its already deployed code, with its existing five-minute Cron. A real Cloudflare comparison of the new code requires a separately approved, isolated free test Worker or an explicitly approved version-routing method; overwriting the production Worker to measure it is not an acceptable test.

The GitHub App read adapter, Durable Object dispatch reservation, workflow allowlist, `WORKFLOW_DISPATCH_ENABLED=false` default, and all dispatch guards remain in the Worker. No dispatch was run by this change. The compact freshness path only supplies its weather/radar states to those existing guards.

## Interpretation limits

- The smaller sidecar reduces Cron JSON bytes from the full weather document to a compact status document and removes the Worker’s MOSMIX-point scan. It also removes four non-target feed checks from each scheduled decision.
- Public status retains the seven-feed detailed path, so its CPU is intentionally unchanged.
- The producer workflow now writes two generated files together. Existing publisher path allowlisting and atomic multi-file publication are tested.
- A successful producer execution is not proof of fresh observations; actual source times remain decisive.
- The PR remains draft and the Worker remains undeployed. No sustained Free-plan headroom is claimed until the changed code is measured on Cloudflare across sufficient runs.
