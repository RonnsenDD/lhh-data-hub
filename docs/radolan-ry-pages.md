# RADOLAN-RY im lhh-data-hub (kostenloser Best-Effort-Betrieb)

Der Decoder in tools/radolan-ry/radolan_ry.py ist unverändert aus dem lokalen DesignTest-Prototyp übernommen. Er lädt nur die jeweils neueste DWD-RY-Datei, prüft HDF5-Metadaten und Rastergeometrie und schreibt keine HDF5-Datei in dieses Repository.

## Bereitstellung

.github/workflows/update-radolan-ry.yml veröffentlicht zunächst nur manuell. Vor dem ersten Lauf muss GitHub Pages im Repository unter Settings → Pages → Build and deployment → Source → GitHub Actions aktiviert sein. Danach im Actions-Tab genau einen manuellen Lauf starten und https://ronnsendd.github.io/lhh-data-hub/radar/latest.json sowie beide PNGs prüfen.

Erst nach erfolgreichem manuellen End-to-End-Test wird der 15-Minuten-Cron-Eintrag aktiviert. Das ist ein Best-Effort-Zeitplan, keine Echtzeitgarantie: GitHub kann Schedule-Läufe verzögern oder auslassen. Der Workflow nutzt ausschließlich ubuntu-latest, öffentliche kostenlose GitHub-Actions für öffentliche Repositories und keine Secrets oder externen kostenpflichtigen Dienste.

Das Pages-Artefakt enthält jeweils nur radar/latest.json und radar/frames/<Frame-ID>/rain.png sowie coverage.png. Pro Veröffentlichung wird das Pages-Artefakt ersetzt; es werden keine HDF5-Archive oder Radar-PNGs in Git commits gespeichert. Der Upload-Artefakt hat ein Aufbewahrungslimit von einem Tag.

Das Deployment-Artefakt enthält außerdem eine minimale `index.html` als Pages-Einstieg. Der Online-Smoke-Test prüft Einstieg, JSON-/PNG-Content-Type, Frame-IDs und Prüfsummen.

## Status und Verträge

- current: DWD-Produktzeit höchstens 15 Minuten alt.
- stale: Produktzeit älter als 15 Minuten.
- unavailable: Abruf, Prüfung oder Dekodierung fehlgeschlagen oder Produktzeit unplausibel.
- Transparente Regenpixel bedeuten nicht „kein Niederschlag bestätigt“; die separate Abdeckungs-PNG kennzeichnet No-Data/außerhalb des gültigen Rasters.
- latest.json enthält UTC-Produkt- und Abrufzeit, Veröffentlichungszeit, Frame-ID, WGS84-Ausdehnung, EPSG:3857-Georeferenzierung, PNG-Pfade und SHA-256-Prüfsummen.

Quellangabe: Deutscher Wetterdienst (DWD), RADOLAN-RY; eigene Rasterdarstellung. Siehe https://www.dwd.de/copyright.

## Integration

Vor der DesignTest-Änderung die bereitgestellte URL aus dem SharePoint-Kiosk mit fetch auf CORS prüfen und die PNGs mit dem vorhandenen MapLibre-Adapter testen. Das Dashboard muss Produktzeit clientseitig selbst neu bewerten; ein alter current-JSON-Status bleibt nach Ablauf der Frischegrenze nicht live.

