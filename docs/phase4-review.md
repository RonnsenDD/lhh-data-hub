# Phase 4 – technische Freigabeprüfung (lokal)

Stand: 2026-10-18. Keine Änderungen an GitHub, SharePoint, DesignTest oder bestehenden Daten-Repositories.

## Lizenz und Quellenhinweis

Das [Impressum des Pegelportals Brandenburg](https://pegelportal.brandenburg.de/impressum.php) erklärt, dass die Nutzungsbedingungen „Datenlizenz Deutschland“ gelten. Der dortige Lizenzlink führt aktuell zur [Datenlizenz Deutschland – Zero – Version 2.0](https://www.govdata.de/dl-de/zero-2-0), die Nutzung und Weitergabe ohne Bedingungen erlaubt. Die stationsbezogenen HTML- und CSV-Antworten enthalten keine eigenen Lizenz-Metadaten; die Prüfung stützt sich auf die portalweite Erklärung im Impressum. Als freiwilligen Quellenvermerk geben die JSONs „Landesamt für Umwelt Brandenburg (LfU), Pegelportal Brandenburg“ mit Messstellen-URL an. Der LfU-Haftungsausschluss bleibt relevant; Daten erhalten daher Messzeit, Abrufzeit und Status.

## Datenquelle und Zeitstempel

Abfrage: `POST https://pegelportal.brandenburg.de/messstelle.php?fgid=7&pkz={5530401|5530302}&thema=q_graph`, Formular `smode=c&sdatum=stunde`. Antworten: Semikolon-CSV, Windows-1252/ISO-8859-kompatibel; Kopfzeile benennt Station und Fehlwert `-777`; Zeilen enthalten `dd.mm.yyyy HH:MM` und Wasserstand in cm. Zeitstempel enthalten keinen Offset. Die Portalansicht zeigt dieselben Uhrzeiten als lokale Brandenburg-Zeit. Der Parser verwendet `Europe/Berlin` und speichert sowohl Offset-Zeit als auch UTC (`measuredAtUtc`).

- MESZ-Test: 18.10.2026 18:00 → `+02:00` → 16:00Z.
- MEZ-Test: 18.01.2026 12:00 → `+01:00` → 11:00Z.
- Nicht existente Zeiten im Frühjahrssprung, doppeldeutige Zeiten beim Herbstsprung, naive Referenzzeiten und Messwerte mehr als 5 Minuten in der Zukunft werden zurückgewiesen, nicht geraten.

## CSV-/Portalvergleich und Datenfrische

Am 18.10.2026 kurz nach 16:06Z ergab der CSV-Abruf für Lauchhammer (5530401) 58 cm um 16:00 MESZ; spätere Zeilen bis 16:45 waren `-777`. Die offizielle Pegelseite enthielt „Letzter Wasserstand: 58 cm am 18. Oktober 2026 16:00“. Für Biehlen 1 (5530302) ergab CSV und Pegelseite 41 cm um 17:00 MESZ. Die Seiten wurden wenige Minuten nach den JSON-Abrufen gelesen; es war ein Abgleich derselben Messzeile, kein sekundengenauer Browser-Screenshot.

Zum JSON-Abruf `2026-10-18T16:06:37Z` waren beide Werte älter als die 45-Minuten-Grenze: Lauchhammer 126 Minuten, Biehlen 1 66 Minuten. Der Parser wählte in unsortierten Daten chronologisch den letzten gültigen Wert und verwarf Sentinelzeilen. Der Abgleich zeigt, dass die damalige Verzögerung bereits in den vom Portal veröffentlichten Messwerten lag, nicht in der Zeitumrechnung oder Auswahl des Parsers. Die frühere Einzelbeobachtung 58 cm um 10:00 gegen 59 cm um 14:00 lässt sich ohne damalige Roh-CSV nicht rückwirkend vollständig belegen.

Die Statusdarstellung dieses Phase-4-Berichts wurde in Phase 5 präzisiert: `stale` gilt nur bei erfolgreichem Abruf und erfolgreicher Verarbeitung mit einem Messwert älter als 45 Minuten. Bei Abruf- oder Verarbeitungsfehlern lautet der Status jetzt `error`; ein vorheriger validierter Messwert kann unter `latestMeasurement` erhalten bleiben, ist damit aber ausdrücklich nicht aktuell. Ohne validierten Vorgänger ist `latestMeasurement` null. Die alte Phase-4-Ausgabe mit `current`/`unavailable` ist ein lokaler Bestand und wird beim nächsten erfolgreichen Abruf migriert; bei einem Fehler wird sie als Fehlerstatus migriert. Aus Pegelwerten wird keine amtliche Alarmstufe abgeleitet.

## Workflow und Veröffentlichung

`.github/workflows/update-levels.yml.example` bleibt ein inaktiver Entwurf. Vorgesehen sind UTC-Cron alle 15 Minuten, `workflow_dispatch`, Concurrency-Schutz, 5-Minuten-Joblimit und nur `contents: write`, damit die JSON-Ausgaben versioniert werden können. Je Quellabruf gelten 20 Sekunden Timeout und ein 2-MB-Antwortlimit; Fehler sind pro Station isoliert und Dateien werden atomar geschrieben. Nach Phase 5 werden auch `stale`-JSONs gespeichert, ohne den Lauf scheitern zu lassen; `error`, ungültige Statuswerte, fehlende Dateien oder `lastAttemptAt` älter als 10 Minuten lassen den Actions-Lauf sichtbar fehlschlagen.

Die frühere `.gitignore`-Regel `data/generated/*.json` wurde entfernt; der Workflow verwendet `git add -f` für beide konkreten JSONs. Damit verhindert weder diese Regel noch eine globale Ignore-Regel versehentlich ihre Aufnahme. Actions werden derzeit über Major-Tags (`@v4`, `@v5`) referenziert; vor Freigabe sollten geprüfte Commit-SHAs gepinnt werden. Repository-weite Actions-Einstellungen konnten über die vorhandene Leseschnittstelle nicht gelesen werden. Secrets wurden nicht abgefragt.

GitHub-Schedules haben keine minutengenaue SLA und können verzögert starten/ausfallen. Erkennung: Run-Historie auf Ausführungslücken von mehr als 30–45 Minuten prüfen, Fehlruns beobachten und `lastAttemptAt`, `retrievedAt`, `status` in den JSONs prüfen. Phase 5 ändert die Workflowprüfung: `stale` ist kein Workflowfehler, während `error`, ein fehlendes JSON oder ein mehr als 10 Minuten alter `lastAttemptAt` den Lauf fehlschlagen lässt. Die Workflowprüfung erkennt keinen komplett ausgebliebenen Lauf; dafür braucht es Run-Historie oder einen separat freigegebenen Monitor.

## Ergebnis und Tests

Zum Abschluss von Phase 4: `python3 -B -m unittest discover -s tests -v`: 19 Tests bestanden. Die nachträglich geänderte Statussemantik und das 48-Stunden-Testverfahren sind in diesem historischen Prüfbericht im obigen Nachtrag sowie in `docs/48h-parallel-test-plan.md` dokumentiert; für den aktuellen Teststand gilt die Phase-5-Prüfung.

Die lokalen Dateien `data/generated/pegel-lauchhammer.json` und `data/generated/pegel-biehlen-1.json` stammen aus dem echten lesenden Abruf, sind beide `stale` und bleiben lokal.

## Veröffentlichungs- und Parallelbetriebsplan

1. Nach Freigabe ein neues öffentliches Repository anlegen und nur diesen Code, Stationskonfiguration und zur Veröffentlichung freigegebene Pegeldaten übernehmen.
2. JSON-Schema, Quellenhinweis, Lizenzzuordnung und Raw-URL-Zugriff prüfen; Workflow zunächst deaktiviert lassen.
3. Nach gesonderter Freigabe einen kontrollierten manuellen Workflowlauf durchführen und beide versionierten, abrufbaren JSONs prüfen.
4. Das bestehende `pegel-lauchhammer-data` unverändert parallel 1–2 Tage betreiben und Messwerte, Mess-/Abrufzeiten, Frische und Workflowläufe vergleichen.
5. Verbraucher erst nach erfolgreichem Vergleich und separater Freigabe umstellen; alten Feed als Rückfall behalten. Stilllegung des alten Feeds ist eine eigene Freigabe.

Keine Veröffentlichung, Aktivierung oder Umstellung wurde vorgenommen.
