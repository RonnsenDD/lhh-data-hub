# lhh-data-hub – lokaler Pegel-Datenentwurf

Öffentliches Datenprojekt für Pegelmessungen des Landesamts für Umwelt Brandenburg (LfU). Er enthält ausschließlich Pegeldaten und keinen Leitstellen-, Feuerwehr-, Einsatz- oder Personenbezug.

## Quelle, Lizenz und Messstellen

Die Abfrage erfolgt per `POST https://pegelportal.brandenburg.de/messstelle.php?fgid=7&pkz={station}&thema=q_graph` mit `smode=c&sdatum=stunde`. Beim dokumentierten Lesetest am 18.10.2026 antworteten beide Messstellen mit HTTP 200 und semikolongetrennter CSV (Windows-1252, Ortszeit Europe/Berlin, Wasserstand in cm; `-777` ist ein Fehlwert).

- Lauchhammer, Schwarze Elster: `5530401`
- Biehlen 1, Schwarze Elster: `5530302`

Das [Impressum des Pegelportals](https://pegelportal.brandenburg.de/impressum.php) verweist auf die [Datenlizenz Deutschland – Zero 2.0](https://www.govdata.de/dl-de/zero-2-0). Die konkrete stationsbezogene Antwort enthält keine eigene Lizenzmetadaten; diese Zuordnung beruht auf der portalweiten Erklärung. Im JSON ist der Quellenhinweis „Landesamt für Umwelt Brandenburg (LfU)“ samt Messstellen-URL enthalten. Das LfU weist auf Haftungsausschlüsse hin. Messwert und Status ersetzen keine amtliche Hochwasserwarnung; es wird keine Alarmstufe aus dem Messwert abgeleitet.

## Status- und Zeitmodell

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

## Workflowentwurf und Veröffentlichungsstatus

`.github/workflows/update-levels.yml.example` ist absichtlich inaktiv. Das Repository wird zunächst ohne aktiven Abrufworkflow veröffentlicht. Der Workflowentwurf fragt beide Pegel in einem Lauf alle 15 Minuten (UTC-Cron) ab, mit `workflow_dispatch`, Concurrency-Schutz und 5-Minuten-Limit. Stale-Messwerte bleiben ein erfolgreicher Fetch-/Verarbeitungslauf. Nur `error`, ein fehlender/unlesbarer Feed oder ein mehr als 10 Minuten alter Laufversuch lässt die Workflow-Prüfung fehlschlagen. Bei einem technischen Fehler bleibt ein vorheriger Wert als `latestMeasurement` erhalten und ist durch Status `error` eindeutig als nicht aktuell markiert.

GitHub-Schedules sind nicht minutengenau garantiert. Der Workflow kann Fehler innerhalb eines gestarteten Laufs melden; vollständig ausgebliebene Läufe müssen über die Actions-Run-Historie oder einen separat freigegebenen Monitor erkannt werden. Vor Veröffentlichung müssen Actions auf geprüfte Commit-SHAs fixiert sowie Lizenz- und Repository-Inhalte nochmals geprüft werden. Bis dahin gilt: keine Repository-Erstellung, Aktivierung oder Veröffentlichung.

## Geplante Parallelprüfung

Die geplante mindestens 48 Stunden lange Vergleichsphase beginnt erst nach gesonderter Freigabe zur Aktivierung. Abnahmekriterien und Rückfallplan stehen in [docs/48h-parallel-test-plan.md](docs/48h-parallel-test-plan.md). Der bisherige Pegel-Feed bleibt währenddessen unverändert und produktive Verbraucher werden erst nach einer separaten Freigabe umgestellt.
