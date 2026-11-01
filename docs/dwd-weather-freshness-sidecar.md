# DWD weather freshness sidecar

`data/generated/dwd-weather-freshness.json` is a compact derivative of the validated `dwd-weather.json` snapshot. It carries source status and timestamps, not measurements or full MOSMIX forecast values. Observation freshness continues to use each original `measuredAt`; MOSMIX age uses the original `issuedAt` and the existing 12-hour rule. `retrievedAt`, `derivedAt`, and `snapshotPublishedAt` describe retrieval, manifest generation, and publication respectively; none substitutes for a source time.

## Forecast timestamps

The additive `forecast.usableValidTimes` field is an ordered, de-duplicated list of original MOSMIX `validAt` strings for points that are at or after `derivedAt` when the sidecar is generated and contain at least one finite numeric forecast value. It contains timestamps only. `forecast.validAt` remains the first entry in that list, and `hasUsablePoint` agrees with whether the list is non-empty. `validThrough` is the greatest valid time present in the source snapshot; by itself it does not prove that a point contains usable values.

Older schemaVersion 1 sidecars without `usableValidTimes` remain valid for readers. Readers must not infer later usable points from `validThrough` alone. When the list is absent and the single `validAt` has elapsed, a reader should report that remaining forecast availability is unknown rather than mark it current or definitively unavailable. The weather workflow validates newly generated manifests with `--require-usable-valid-times` before publishing.

The public `ok` status records the producer's result at generation time; consumers still evaluate source timestamps against the current time. The full DWD snapshot and sidecar are published together by the allowlisted publisher only after the existing snapshot validator succeeds.
