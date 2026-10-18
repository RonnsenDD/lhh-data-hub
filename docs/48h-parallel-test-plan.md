# 48-Stunden-Paralleltest – Pegel Lauchhammer und Biehlen 1

## Ziel und Sicherheitsgrenze

Verglichen werden ausschließlich die öffentlichen Pegeldaten für Lauchhammer (5530401) und Biehlen 1 (5530302) aus dem lokalen `lhh-data-hub`-Entwurf und dem bereits bestehenden Pegel-Datenfeed. Die bestehenden Repositories und Verbraucher bleiben unverändert. Vor Veröffentlichung/Start muss ein Prüfer den tatsächlichen Beginn und das Ende in UTC in das Testprotokoll eintragen. Mindestdauer: 48 zusammenhängende Stunden; bei längeren Ausfällen wird der Test verlängert, bis die Mindestbeobachtung und die Abnahmekriterien erfüllt sind.

## Je Beobachtung erfassen

Für jede Station und jeden verfügbaren Lauf / Datensatz protokollieren:

- geplanter und tatsächlicher Laufzeitpunkt (UTC), sowie ob ein Actions-Lauf überhaupt gestartet ist;
- Stationskennung und Quell-URL;
- Messwert in cm, `measuredAt` mit `Europe/Berlin`-Offset und `measuredAtUtc`;
- `retrievedAt`, `lastAttemptAt`, `ageMinutes`, Frischegrenze und Status (`ok`, `stale`, `error`);
- entsprechender Wert und Messzeitpunkt des bisherigen Feeds;
- Abweichung in cm und Zeitdifferenz der Messungen;
- HTTP-/Parser-/Workflowfehler, fehlende Datei, Duplikat oder Schemaabweichung.

Keine Differenz anhand bloß ähnlicher Zeitstempel als Messfehler klassifizieren: wenn die Quelle zu verschiedenen Zeiten aktualisiert, Messwert und Messzeit gemeinsam vergleichen. Zeitstempel sind ISO 8601 mit Offset; die CSV-Ortszeit wird mit `Europe/Berlin` interpretiert, nicht mit der Runner-Zeitzone.

## Ablauf

1. Vor Beginn dokumentieren, dass beide bestehenden Datenfeeds erreichbar sind und ihre aktuellen JSON-Dateien gesichert beziehungsweise abrufbar sind. Keine Datenquellen umschalten.
2. Nach separater Freigabe den neuen öffentlichen Workflow aktivieren. Der 15-Minuten-Schedule ist ein Zielintervall, keine GitHub-SLA. Run-Historie und Dateizeitstempel prüfen.
3. Mindestens alle 15 Minuten, soweit beide Feeds neue Daten liefern, beide Datensätze sichern oder in ein Prüfprotokoll aufnehmen. Nur öffentliche Pegelwerte und Zeit-/Statusmetadaten verwenden.
4. Während 48 Stunden regelmäßig kontrollieren: fehlende Ausführungen, `error`, `stale`, Abruf-/Messzeit-Alter, Identität der Station und Feed-Verfügbarkeit. Einen `stale`-Wert nicht als aktuell werten.
5. Am Ende Unterschiede klassifizieren: erwartbare Quellenlatenz, Zeitversatz, tatsächliche Werteabweichung, Parserfehler, Feed-/Workflowausfall oder nicht erklärter Unterschied.

## Abnahmekriterien

- Beide Stationen bleiben eindeutig gemappt; keine Werte werden zwischen Stationen vertauscht.
- JSON-Schema ist stabil und enthält getrennte Mess-, Abruf- und Versuchsdaten.
- Jeder technische Fehler wird sichtbar als `error` und schlägt den Actions-Lauf fehl; ein erfolgreicher Abruf mit altem Wert wird `stale`, ohne deshalb den Lauf scheitern zu lassen.
- Keine unerklärte Messwertabweichung bei derselben Stationskennung und demselben Messzeitpunkt; erwartbare Rundung/Formatierung ist dokumentiert.
- Keine nicht erklärte Umrechnung bei MEZ/MESZ oder doppelten/nicht existierenden DST-Zeiten.
- Kein unerkannter Ausführungsabstand über 30 Minuten: Ausbleibende Runs werden protokolliert und die Schedule-Zuverlässigkeit separat bewertet. Dieser Punkt kann nicht vom Workflow selbst garantiert werden.
- Die 48 Stunden sind vollständig dokumentiert; alle Fehler, Lücken und stale-Phasen sind erklärt. Unerklärte Abweichungen oder wiederholte technische Fehler blockieren die Umstellung.

## Rückfall

Während des Tests bleibt der alte Feed die unveränderte Referenz und produktive Quelle. Bei Problemen wird der neue Workflow deaktiviert oder der Test beendet; es erfolgt keine Änderung an alten Daten/Workflows. Für eine spätere Umstellung werden alter Feed, URL und Version als Rückfall bewahrt. Umschaltung und Stilllegung alter Komponenten benötigen jeweils eigene Freigaben.

## Protokollvorlage

| UTC-Zeit | Run gestartet | Station | Neu: Wert / Messzeit | Neu: Status / Alter | Alt: Wert / Messzeit | Abweichung | Ergebnis/Fehler |
|---|---|---|---|---|---|---|---|

Status: Vorbereitungsvorlage; kein 48-Stunden-Test wurde durch dieses lokale Projekt gestartet.
