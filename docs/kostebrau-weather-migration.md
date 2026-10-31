# Kostebrau weather Hub migration

The Hub's DWD-only snapshot is a separate product; this feed keeps the DB0LS
WeeWX station in Kostebrau as its own observation source. It writes only
`data/generated/kostebrau-weather.json`.

The output preserves the DesignTest `weather.json` contract fields:
`location`, `station`, `source`, `weather`, `measuredAt`,
`retrievedAt`, `temperatureC`, `humidityPercent`, `pressureHpa`,
`windKmh`, `windDirection`, `gustKmh`, `gustDirection`,
`rainTotalCm`, `rainRateCmH`, `maxRainRateCmH`, and `status`.
Additional fields separate Europe/Berlin source wall time, UTC time when
unambiguous, retrieval time, source age, and the 45-minute freshness state.
Station time—not model time or retrieval time—determines freshness.

This producer is a temporary shadow run at the existing five-minute cadence.
The public legacy producer and DesignTest binding remain unchanged until a
minimum 48-hour comparison passes. On 2026-10-31, the public snapshot and the
read-only station page reported different measurement times, and the observed
station time was older than DesignTest's 45-minute threshold. Do not switch
until that discrepancy is explained and repeated automatic Hub publications
are verified.

After acceptance, DesignTest needs only a source-URL change to:
`https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/kostebrau-weather.json`.
Then stop the old `wetter-lauchhammer-data` schedule in a separate PR.
Do not delete the manual-only `wetter-lauchhammer` repository or public data
archive during cutover.
