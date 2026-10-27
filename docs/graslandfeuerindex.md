# DWD-Graslandfeuerindex im lhh-data-hub

## Quelle und Lizenz

- Anbieter: Deutscher Wetterdienst, CDC Open Data
- Produkt: DWD-Graslandfeuerindex (Vorhersage `v2-0--0`)
- Mess-/Prognosestelle: Schipkau-Klettwitz, Stationskennung `2627`
- Abruf: [DWD-CDC CSV-GZIP-Datei](https://opendata.dwd.de/climate_environment/CDC/derived_germany/fire_danger_index/grassland/forecast/recent/derived_germany_fire_danger_index_grassland_forecast_recent_2627_v2-0--0.csv.gz)
- Nutzungsbedingungen CDC Open Data: [CC BY 4.0](https://opendata.dwd.de/climate_environment/CDC/Nutzungsbedingungen_German.pdf)
- DWD-Produkthinweise: [Dokumentation Graslandfeuerindex](https://www.dwd.de/DE/fachnutzer/landwirtschaft/dokumentationen/allgemein/glfi_erlaeuterungen.pdf?__blob=publicationFile&v=9)

Die Stationsprognose wird laut DWD ungefähr täglich gegen 05:00 UTC aktualisiert. Der Hub-Workflow läuft täglich um 05:15 UTC, außerdem ist er manuell startbar. Standard-GitHub-hosted `ubuntu-latest`, keine Zusatzdienste und keine Secrets werden verwendet.

## Öffentlicher Feed

`https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/graslandfeuerindex.json`

Der Pfad ist neu. Der bisherige Dashboard-Endpunkt `https://raw.githubusercontent.com/RonnsenDD/dwd-graslandfeuerindex-lauchhammer/main/data/graslandfeuerindex.json` bleibt bis zur getrennten Abnahme unverändert.

## Datenvertrag (schemaVersion 1)

Der Vertrag erhält die bisherige Struktur (`station`, `status`, `retrievedAt`, `source`, `today`, `days`) und ergänzt `lastSuccessfulAt`, `lastAttemptAt`, `statusReason` sowie bei einem Abruffehler `lastError`.

- `station`: `name` und DWD-Stations-ID
- `today`: Tagesprognose für das aktuelle Datum in `Europe/Berlin`, andernfalls `null`
- `days`: sieben aufeinanderfolgende Daten mit ISO-Datum und DWD-Klasse `1` bis `5`
- `source.dataAsOf`: Zeitstempel der DWD-Prognose aus `Termin` (UTC)
- `source.lastModifiedAt`: HTTP-`Last-Modified`, falls vom DWD geliefert; sonst `null`
- `retrievedAt` und `lastSuccessfulAt`: letzter erfolgreich heruntergeladener und validierter Feed
- `lastAttemptAt`: letzter Abrufversuch
- `status`: `ok`, `stale` oder `error`

Ein erfolgreicher Abruf ohne heutigen Wert oder mit einer mehr als 36 Stunden alten Quelle bleibt `stale`. Bei HTTP-, GZIP- oder Parserfehlern bleibt ein vorhandener, validierter Vorwert als `stale` markiert; `lastSuccessfulAt` und Prognosedaten bleiben unverändert. Ohne gültigen Vorwert wird ein `error`-Dokument ohne Prognosewerte geschrieben. Der Workflow veröffentlicht den Statusdatensatz und meldet technische Abruffehler als fehlgeschlagenen Lauf. Fehler werden nie als erfolgreich leere Prognose ausgegeben.

## Ausführung und Parallelität

`.github/workflows/update-graslandfeuerindex.yml` verwendet `workflow_dispatch`, einen täglichen UTC-Zeitplan, `contents: write` nur für dieses Repository und eine eigene Concurrency-Gruppe. Pegelabruf und Pegelworkflow werden nicht aufgerufen oder verändert. Der Workflow führt die GLFI-Tests aus, ruft danach DWD ab, validiert die JSON-Ausgabe und versioniert ausschließlich die neue GLFI-Datei. Abruffehler werden als sichtbarer fehlgeschlagener Lauf markiert.

Lokaler Test:

```sh
python3 -B -m unittest discover -s tests -p 'test_graslandfeuerindex_fetch.py' -v
python3 -B src/graslandfeuerindex_fetch.py --validate-only --output data/generated/graslandfeuerindex.json
```

Der öffentliche Feed ist eine neue Quelle; eine Dashboard-Änderung ist erst nach bestätigtem Live-Lauf und gesonderter Abnahme nötig. Der alte private Workflow wird erst nach erfolgreichem Parallelvergleich, Aktualitätsprüfung des neuen Endpunkts und expliziter Freigabe abgeschaltet.
