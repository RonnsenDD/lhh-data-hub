# lhh-data-hub – öffentliche Datenfeeds

Öffentlicher Datenhub für nicht vertrauliche Wetter- und Umweltdaten aus amtlichen Quellen. Der Hub enthält keine Leitstellen-, Feuerwehr-, Einsatz- oder Personendaten.

## Pegelquelle, Lizenz und Messstellen

Die Abfrage erfolgt per `POST https://pegelportal.brandenburg.de/messstelle.php?fgid=7&pkz={station}&thema=q_graph` mit `smode=c&sdatum=stunde`. Beim dokumentierten Lesetest am 18.10.2026 antworteten beide Messstellen mit HTTP 200 und semikolongetrennter CSV (Windows-1252, Ortszeit Europe/Berlin, Wasserstand in cm; `-777` ist ein Fehlwert).

- Lauchhammer, Schwarze Elster: `5530401`
- Biehlen 1, Schwarze Elster: `5530302`

Das [Impressum des Pegelportals](https://pegelportal.brandenburg.de/impressum.php) verweist auf die [Datenlizenz Deutschland – Zero 2.0](https://www.govdata.de/dl-de/zero-2-0). Die konkrete stationsbezogene Antwort enthält keine eigene Lizenzmetadaten; diese Zuordnung beruht auf der portalweiten Erklärung. Im JSON ist der Quellenhinweis „Landesamt für Umwelt Brandenburg (LfU)“ samt Messstellen-URL enthalten. Das LfU weist auf Haftungsausschlüsse hin. Messwert und Status ersetzen keine amtliche Hochwasserwarnung; es wird keine Alarmstufe aus dem Messwert abgeleitet.

## Pegel-Status- und Zeitmodell

- `ok`: Abruf und Verarbeitung erfolgreich; Messalter höchstens 45 Minuten.
- `stale`: Abruf und Verarbeitung erfolgreich, aber der letzte gültige Messwert ist älter als 45 Minuten. Das ist ein erfolgreicher Workflowlauf, aber kein aktueller Messwert.
- `error`: Abruf oder Verarbeitung ist technisch fehlgeschlagen. Ein gültiger letzter Messwert darf als `latestMeasurement` erhalten bleiben, aber der Datensatz bleibt `error` und darf nicht als aktuell behandelt werden.

Zeitangaben getrennt führen: `latestMeasurement.measuredAt` (Europe/Berlin), `latestMeasurement.measuredAtUtc` (UTC), `retrievedAt` (letzter erfolgreicher Abruf/Verarbeitung), `lastAttemptAt` (letzter Versuch) und `ageMinutes` (bezogen auf den Messzeitpunkt). Bei Fehler bleibt `retrievedAt` der letzte erfolgreiche Abruf; `lastAttemptAt` wird aktualisiert. Gibt es keinen validierten Vorgänger, sind `latestMeasurement`, `retrievedAt` und `ageMinutes` null. Sentinel-, ungültige oder zeitlich unmögliche Werte werden nicht als Messung ausgegeben.

## Lokale Tests

Python-Standardbibliothek, keine Drittanbieter-Abhängigkeiten:

```sh
python3 -B -m unittest discover -s tests -v
```

Der Live-Abruf ist separat und lesend:

```sh
python3 src/pegel_fetch.py --output-dir data/generated
```

Er schreibt `data/generated/pegel-lauchhammer.json` und `data/generated/pegel-biehlen-1.json`. Beide lokalen Dateien sind Testausgaben und nicht automatisch zur Veröffentlichung freigegeben. Die JSONs sind nicht durch `.gitignore` ausgeschlossen; der Workflowentwurf fügt genau beide Dateien zusätzlich mit `git add -f` hinzu.

## Workflows und veröffentlichte Daten

`.github/workflows/update-levels.yml` ist der bestehende Pegelworkflow. Er ruft ausschließlich die beiden dokumentierten LfU-Pegel ab; seine Konfiguration bleibt von der Graslandkomponente unberührt.

Der unabhängige GLFI-Workflow ist unter `.github/workflows/update-graslandfeuerindex.yml` dokumentiert. Er verwendet einen Standard-`ubuntu-latest`-Runner, einen eigenen täglichen Lauf um 05:15 UTC, `workflow_dispatch`, eine eigene Concurrency-Gruppe und schreibt nur `data/generated/graslandfeuerindex.json`. Es werden keine zusätzlichen Secrets oder kostenpflichtigen Dienste benötigt.

## DWD-Graslandfeuerindex

Die Komponente liest die DWD-CDC-Prognose für Schipkau-Klettwitz (2627) aus der offiziellen [DWD-Open-Data-Datei](https://opendata.dwd.de/climate_environment/CDC/derived_germany/fire_danger_index/grassland/forecast/recent/derived_germany_fire_danger_index_grassland_forecast_recent_2627_v2-0--0.csv.gz). Der DWD-CDC-Datenbereich steht unter [CC BY 4.0](https://opendata.dwd.de/climate_environment/CDC/Nutzungsbedingungen_German.pdf); Quelle und Lizenz sind im JSON enthalten. Der DWD beschreibt eine tägliche Bereitstellung um etwa 05:00 UTC und prognostiziert sieben Tage. Details stehen in [docs/graslandfeuerindex.md](docs/graslandfeuerindex.md).

Neue, zunächst getrennte JSON-URL:

`https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/graslandfeuerindex.json`

Der bisherige Dashboard-Endpunkt `https://raw.githubusercontent.com/RonnsenDD/dwd-graslandfeuerindex-lauchhammer/main/data/graslandfeuerindex.json` bleibt bis zur Abnahme unverändert. Die erste Hub-Datei ist ausdrücklich `stale` markiert und trägt den Datenstand 2026-10-23; sie wird erst nach einem erfolgreichen DWD-Lauf aktuell. Der Vertrag erhält die bisherigen Felder und ergänzt Abrufversuch, letzten erfolgreichen Abruf und Statusbegründung. Technische Fehler halten den letzten validierten Stand auf `stale`, oder erzeugen ohne Vorwert einen `error` ohne Prognosedaten.

## Geplante Parallelprüfung

Die geplante mindestens 48 Stunden lange Vergleichsphase beginnt erst nach gesonderter Freigabe zur Aktivierung. Abnahmekriterien und Rückfallplan stehen in [docs/48h-parallel-test-plan.md](docs/48h-parallel-test-plan.md). Der bisherige Pegel-Feed bleibt währenddessen unverändert und produktive Verbraucher werden erst nach einer separaten Freigabe umgestellt.
