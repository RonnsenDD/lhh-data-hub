# Waldbrandgefahrenstufe Oberspreewald-Lausitz

## Quelle und Nutzungshinweis

Der Produzent liest die offizielle Tagesübersicht des Ministeriums für Land- und Ernährungswirtschaft, Umwelt und Verbraucherschutz des Landes Brandenburg (MLEUV):

`https://mleuv.brandenburg.de/mleuv/de/umwelt/forst/waldschutz/waldbrandgefahr-in-brandenburg/waldbrandgefahrenstufen/`

Die Quellseite verlangt bei Verwendung eine Quellenangabe. Dieser Feed führt deshalb den Namen des Ministeriums und die Quell-URL mit. Auf der geprüften Seite ist keine ausdrückliche Datenlizenz ausgewiesen. Die dortige Bitte um Mitteilung an die Webredaktion bezieht sich ausdrücklich auf das Einbinden der MLEUV-Karte. Vor einer produktiven Dashboardnutzung des extrahierten Wertes ist die zulässige Weiternutzung dennoch zu klären; dieses PR-Set richtet keine externe Veröffentlichung oder Dashboardumschaltung selbst ein.

Die Landkreis-Zuordnung verwendet den Regionalschlüssel `12066` (Landkreis Oberspreewald-Lausitz). Es werden ausschließlich das auf der MLEUV-Seite ausgewiesene Datum und die dortige Stufe 1–5 übernommen. Der Produzent enthält keine SharePoint-, Azure- oder sonstigen Zugangsdaten und führt keinerlei SharePoint-Schreibzugriff aus.

## Öffentlicher Datenvertrag

Nach Aufnahme in `main` ist der Snapshot für GitHub Pages unter folgender URL vorgesehen:

`https://ronnsendd.github.io/lhh-data-hub/data/generated/waldbrandgefahrenstufe-osl.json`

Wichtige Felder:

- `sourceDate`: offizielles MLEUV-Veröffentlichungsdatum, nicht der Abrufzeitpunkt.
- `retrievedAt` und `lastSuccessfulAt`: Zeitpunkt des letzten validierten Abrufs in UTC.
- `lastAttemptAt`: letzter Abrufversuch in UTC.
- `status`: `current`, `stale` oder `unavailable`, bewertet anhand des Quelldatums und des Kalendertags in `Europe/Berlin`.
- `fetchStatus`: `success`, `error` oder `not-attempted`; ein erfolgreicher HTTP-Abruf macht ein altes Quelldatum nicht aktuell.
- `level`: ganzzahlig 1–5 oder `null`; bei fehlendem gültigem Snapshot werden keine Werte erfunden.
- `lastError`: sicherer technischer Fehlerhinweis ohne Antwort-HTML oder Credentials.
- `source`: Anbieter, URL, Attribution und der Hinweis, dass keine ausdrückliche Lizenz auf der Quellseite angegeben ist.

Ein Abruffehler behält den letzten geprüften Wert und sein Quelldatum bei, setzt `fetchStatus: error` und aktualisiert nur `lastAttemptAt`. Das `status` bleibt ausschließlich vom gespeicherten offiziellen Quelldatum abhängig. Eine neu gelieferte Quelle mit einem gegenüber dem letzten Snapshot zurückgegangenen Datum wird nicht veröffentlicht. Ein initialer Fehler veröffentlicht ein `unavailable`-Manifest ohne Stufe.

## Ablauf und Schutz

`update-waldbrandgefahrenstufe-osl.yml` läuft täglich um 07:20 UTC (08:20 MEZ bzw. 09:20 MESZ) und kann zusätzlich manuell gestartet werden. Es verwendet `ubuntu-latest`, Python 3.12 und keine Secrets außer dem kurzlebigen, automatisch bereitgestellten `GITHUB_TOKEN` für den GitHub-Audit. Der geschützte Publisher akzeptiert ausschließlich die freigegebene generierte JSON-Datei, integriert unabhängige Änderungen an `main` ohne Force-Push und bricht bei einem konkurrierenden Update desselben Snapshots ab.

Der Schedule-Audit meldet Ausführungslücken getrennt vom fachlichen Quellabruf. Ein erfolgreicher Producer-Job und ein aktuelles Quelldatum werden separat bewertet. Der Workflow importiert weiterhin nicht nach SharePoint.

## Lokale Prüfung

```sh
python3 -B -m unittest discover -s tests -p 'test_waldbrandgefahrenstufe_fetch.py' -v
python3 -B src/waldbrandgefahrenstufe_fetch.py --source-only
python3 -B src/waldbrandgefahrenstufe_fetch.py --validate-only --output data/generated/waldbrandgefahrenstufe-osl.json
```

`--source-only` ruft die aktuelle MLEUV-Seite ab und zeigt HTTP-/Parser-Ergebnis, Quelldatum, Stufe und Status, schreibt aber keine Datei. Ein veralteter offizieller Tagesstand liefert einen vom Erfolg getrennten `stale`-Status. Vor produktiver Nutzung sind wiederholte automatische Ausführungen, die Lizenz-/Weiterverwendungsfrage und ein kontrollierter Dashboard-Adaptertest erforderlich. Der frühere private Erzeuger darf bis zu diesem Nachweis nicht abgeschaltet werden.
