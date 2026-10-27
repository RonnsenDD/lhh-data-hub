# DWD KONRAD3D publishing

The KONRAD3D producer reuses the DesignTest parser (`konradParser.mjs`) and writes only the `konrad3d/` branch of the Pages artifact. RADOLAN remains under `radar/`; the single existing Pages workflow assembles both products before deployment.

Public contract:

- `https://ronnsendd.github.io/lhh-data-hub/konrad3d/latest.json`
- `https://ronnsendd.github.io/lhh-data-hub/konrad3d/cells.geojson`

`referenceTime` is the DWD product reference time; `creationTime`, `retrievedAt` and `publishedAt` are separate. `current` requires a valid product no older than 15 minutes at publication. A valid empty `<cells/>` is a successful result, with `cellResult: no-cells-detected`; a product containing only cells outside the local 220 km processing envelope reports `no-cells-in-area`. `stale` may retain cell geometry in the artifact for diagnostics, but the dashboard never loads or displays it. `unavailable` publishes an empty FeatureCollection and a bounded error message.

The historical XML fixture is used only by tests and is not copied into the Pages site. It contains cells outside the local dashboard envelope and must remain stale when evaluated against a current clock.
