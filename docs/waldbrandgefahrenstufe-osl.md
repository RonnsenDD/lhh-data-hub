# Waldbrandgefahrenstufe Oberspreewald-Lausitz

## Quelle und Nutzungshinweis

Der Produzent liest die offizielle Tagesübersicht des Ministeriums für Land- und Ernährungswirtschaft, Umwelt und Verbraucherschutz des Landes Brandenburg (MLEUV):

`https://mleuv.brandenburg.de/mleuv/de/umwelt/forst/waldschutz/waldbrandgefahr-in-brandenburg/waldbrandgefahrenstufen/`

Die Quellseite bietet ausdrücklich einen maschinenlesbaren XML-Export der Tagesstufen unter `https://mleuv.brandenburg.de/mleuv/de/wgs.xml` an. Sie nennt als Quelle das Ministerium; der Export einer einzelnen Tabellenstufe ist keine Einbettung der Karte. Die Bitte um E-Mail an die Webredaktion steht ausdrücklich beim Einbetten der MLEUV-Karte und wird durch diesen JSON-Feed nicht ausgelöst.

Auf der konkreten Quellseite und im XML-Export ist keine benannte Einzel-Lizenz ausgewiesen. Die Rechtsprüfung fand aber keine entgegenstehende Nutzungsbeschränkung: § 4a BbgEGovG verlangt für von Landesbehörden öffentlich elektronisch bereitgestellte Daten maschinenlesbare und möglichst offene Bereitstellung, sofern keine Rechte Dritter entgegenstehen; § 2 DNG erfasst öffentlich bereitgestellte Behördendaten und § 4 DNG lässt deren kommerzielle und nichtkommerzielle Nutzung grundsätzlich zu. Die Daten werden bereits öffentlich als XML exportiert. Der Feed übernimmt ausschließlich die sachliche Landkreisstufe und das Quelldatum, keine Karte, Grafik oder sonstigen Seiteninhalte. Auf dieser Grundlage ist die Weiterveröffentlichung des einzelnen OSL-Wertes mit Quellenangabe hinreichend gestützt. Das ist eine technische Nutzungsprüfung, keine individuelle Rechtsberatung; sollte die Behörde künftig ausdrückliche abweichende Bedingungen veröffentlichen, ist die Veröffentlichung auszusetzen und neu zu bewerten.

Attribution im Feed und bei der Anzeige: **Quelle: Ministerium für Land- und Ernährungswirtschaft, Umwelt und Verbraucherschutz des Landes Brandenburg (MLEUV)**, mit Link zur obenstehenden Quellseite.

Die Landkreis-Zuordnung verwendet den Regionalschlüssel `12066` (Landkreis Oberspreewald-Lausitz). Es werden ausschließlich das auf der MLEUV-Seite ausgewiesene Datum und die dortige Stufe 1–5 übernommen. Der Produzent enthält keine SharePoint-, Azure- oder sonstigen Zugangsdaten und führt keinerlei SharePoint-Schreibzugriff aus.

## Öffentlicher Datenvertrag

Der bestehende RADOLAN/KONRAD3D-Pages-Workflow baut ein eigenes `radar/`- und `konrad3d/`-Artefakt; er veröffentlicht nicht den gesamten Repository-Baum. Dieser Waldbrand-Snapshot wird vom guarded publisher als Datei auf `main` abgelegt und ist deshalb nach erfolgreicher Veröffentlichung über Raw GitHub erreichbar:

`https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/waldbrandgefahrenstufe-osl.json`

Eine URL unter `ronnsendd.github.io/lhh-data-hub/data/generated/` ist für diesen Datenpfad nicht vorgesehen und darf nicht als Dashboard-Endpunkt verwendet werden.

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

`--source-only` ruft die aktuelle MLEUV-Seite ab und zeigt Parser-Ergebnis, Quelldatum, Stufe und Status, schreibt aber keine Datei. Ein veralteter offizieller Tagesstand liefert einen vom Erfolg getrennten `stale`-Status. Vor dem Dashboardwechsel sind mindestens zwei erfolgreiche automatische Veröffentlichungen und ein kontrollierter Adaptertest erforderlich. Der frühere private Erzeuger darf bis zu diesem Nachweis nicht abgeschaltet werden.
