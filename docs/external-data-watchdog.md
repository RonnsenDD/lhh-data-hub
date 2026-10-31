# Cloudflare Watchdog V2 — observe-only

No GitHub REST/API, tokens, secrets, persistence product, writes, workflow dispatch, or producer/schedule changes. Existing Worker: `feuerwehr-lauchhammer-watchdog`, existing Cron `*/5 * * * *`. This PR does not touch the deployed Cloudflare installation.

## Verified public paths and source-time rules

Paths were checked against Data Hub main tree commit `cc68ba822113b7b906c47f839471158852f08ecf` and DesignTest adapters.

- DWD JSON: `https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/dwd-weather.json`. Product measurements use individual `observations.*.measuredAt` (45 min); MOSMIX uses `forecast.issuedAt` (12 h) plus future `points[].validAt`.
- Lauchhammer: `https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/pegel-lauchhammer.json`, Biehlen: `https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/pegel-biehlen-1.json`. Compare separate `latestMeasurement.measuredAtUtc` (fallback to offset timestamp), max 45 min.
- RADOLAN: `https://ronnsendd.github.io/lhh-data-hub/radar/latest.json`, `productTime` max 15 min.
- KONRAD3D: `https://ronnsendd.github.io/lhh-data-hub/konrad3d/latest.json`, `referenceTime` max 15 min; explicit `publishedAt` separate.
- GLFI: `https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/graslandfeuerindex.json`; `source.dataAsOf` max 36 h and one forecast for Berlin today.
- Wildfire: `https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/waldbrandgefahrenstufe-osl.json`; `sourceDate` valid 08:00–08:00 Europe/Berlin, DST aware.

Producer retrieval times, HTTP Date/Age/Last-Modified and source measurement times stay distinct. Only an explicit JSON `publishedAt` becomes JSON publication time; otherwise the report says null. Transport Last-Modified is not presented as an exact Git commit time.

## Status meanings / protections

`OK` current by source time/official validity; `STALE` old/expired; `UNAVAILABLE` 404 or required value absent; `ERROR` timeout/network/429/5xx/invalid JSON; `UNKNOWN` missing or implausible timestamp. Each feed is isolated, 4 concurrent GETs maximum, 12s timeout, 256KiB body ceiling; no retry in the same tick. 5-minute cache-busting query, but source times determine freshness.

Read-only `GET /` or `GET /status` returns a limited JSON report, no raw feed body or secrets. Only GET/OPTIONS; SharePoint origin is the only browser CORS origin. Each endpoint call checks live feeds (no stored last-cron state); scheduled checks write one compact JSON record to existing Worker logs. No administration/action endpoint exists.

## Free tier / manual update (not done)

Workers Free currently documents 100k requests/day, 50 subrequests/invocation, 5 Cron triggers/account, and 10ms CPU per Cron. Each check requests 7 feeds; max four concurrent. Account slot, usage and CPU are not live-verified; no SLA is claimed. Free-only operation must first pass a runtime CPU probe; do not switch to Paid if 10ms is exceeded. Official docs: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

To update existing installation later: backup current script/version; open existing Worker in Cloudflare Dashboard; replace editor module with full `tools/watchdog/worker.js`; preview `GET /status`; check CPU, seven statuses, CORS and logs; publish only after approval; verify exactly the existing Cron still runs; rollback to saved deployment if any free limit/error appears. Do not create another Worker/Cron.

Pilot: 48 h (~576 cron checks); all seven feeds show a status each tick; compare source times with JSON; no writes/API calls; verify Berlin 08:00 boundary and DST fixtures; confirm no Free limits. Without storage there is no persisted history or workflow restart, just logs and per-request report. Active workflow dispatch is excluded and would need a separate project.
