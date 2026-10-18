# Phase 5 – lokaler Veröffentlichungsstand

Stand: 2026-10-18. Nur lokale Projektdateien wurden geändert. Kein GitHub-Repository wurde erstellt, kein Workflow gestartet, und keine bestehenden Repositories, SharePoint-Seiten oder DesignTest-Dateien wurden verändert.

## Vorgesehene öffentliche Struktur

```text
lhh-data-hub/
├── .github/workflows/update-levels.yml       # nach Freigabe aus *.example übernehmen
├── config/stations.json                      # ausschließlich öffentliche Messstellen
├── data/generated/pegel-lauchhammer.json
├── data/generated/pegel-biehlen-1.json
├── docs/48h-parallel-test-plan.md
├── docs/phase4-review.md
├── docs/phase5-readiness.md
├── src/pegel_fetch.py
├── tests/test_pegel_fetch.py
├── .gitignore
└── README.md
```

Der lokale Workflow verbleibt als `.github/workflows/update-levels.yml.example`, damit er nicht aktivierbar ist, solange er nicht ausdrücklich nach Freigabe in `.yml` umbenannt wird. Der Plan erfordert vor Veröffentlichung einen letzten Inhalts-/Lizenzreview und das Fixieren der GitHub Actions auf geprüfte Commit-SHAs.

## Statusvertrag

`ok` = erfolgreicher Abruf und Verarbeitung, Messalter <=45 Minuten. `stale` = erfolgreicher Abruf/Verarbeitung, letzter gültiger Messwert >45 Minuten alt. `error` = technische Abruf-/Verarbeitungsstörung. Der Actions-Prüfschritt akzeptiert nur `ok` und `stale`; `error`, unbekannter Status, fehlende Datei oder ein Versuch älter als 10 Minuten schlägt den Lauf fehl. Ein vollständig nicht gestarteter Schedule ist anhand der GitHub-Run-Historie zu erkennen.

Im Fehlerfall bleibt, wenn validiert, ein letzter Messwert unter `latestMeasurement` erhalten. Der Status ist trotzdem `error`; `retrievedAt` bleibt der Zeitpunkt des letzten erfolgreichen Abrufs. `lastAttemptAt` wird auf den fehlgeschlagenen Versuch gesetzt. Die Messung darf bei `error` weder als aktuell etikettiert noch als verlässlich aktuelle Ausgabe konsumiert werden. Ohne gültigen Vorgänger ist die Messung null.

## Lokale Testausgaben und Datenrisiko

Die beiden `data/generated/*.json` wurden am 18.10.2026 in Phase 6 durch einen ausdrücklich angeforderten einmaligen lesenden Abruf aktualisiert. Die zuletzt gelieferten Messungen waren bereits 82 Minuten (Lauchhammer) bzw. 67 Minuten (Biehlen 1) alt und bleiben daher korrekt `stale`. Sie sind echte öffentliche Pegelportalwerte, aber nicht aktuell; der Status und die Zeitfelder verhindern eine irreführende Kennzeichnung. Vor dem 48-Stunden-Test dürfen stale Ausgaben nicht als aktuelle Werte dargestellt werden.

In der Arbeitskopie sind außer Stationsmetadaten, Parser, Tests, Workflowentwurf, Dokumentation und diesen zwei öffentlichen Pegel-Snapshots keine Zugangsdaten oder internen Leitstellen-/Feuerwehrdaten vorgesehen. `.gitignore` enthält keine generierten JSON-Ausschlüsse; der Workflow setzt `git add -f` auf genau die zwei Ausgabedateien. Vor tatsächlichem Push trotzdem vollständige Diff-/Secret-Prüfung durchführen. Es wurde kein Secret-Wert gelesen oder gespeichert. Dieses Verzeichnis ist derzeit kein initialisiertes Git-Repository; tatsächliche Git-Indexierung/Remote-Veröffentlichung wurde nicht getestet.

## Prüfungsergebnis

- Lokale automatisierte Tests: 22 bestanden (nur synthetische Fixtures; keine Netzabrufe).
- Python-Syntax: geprüft.
- Workflowentwurf: Ruby YAML parser parse erfolgreich; Workflow bleibt `.example` und wurde nicht gestartet.
- JSON-Ausgaben: Status und Zeitfelder offline geprüft; letzter Datenstand ist historisch und stale.
- 48-Stunden-Vergleich: Plan liegt in `docs/48h-parallel-test-plan.md`; der Beobachtungstest wurde nicht gestartet.

## Freigabeschritte vor öffentlichem Testbetrieb

1. Öffentliche Repository-Erstellung ausdrücklich freigeben.
2. Code-/Lizenz-/Secret-Diff nochmals prüfen, Workflowactions auf geprüfte SHAs fixieren und öffentliches Ziel bestätigen.
3. Nach eigener Freigabe das neue Repository anlegen und Inhalte veröffentlichen, Workflow zunächst weiterhin inaktiv lassen.
4. Getrennte Freigabe für Aktivierung bzw. einmaligen Testlauf einholen; keine Produktivverbraucher umstellen.
5. Mindestens 48 Stunden Parallelbetrieb anhand des Testplans durchführen und dokumentieren.
6. Feed-Umstellung und spätere Stilllegung des alten Repositories benötigen jeweils eine separate Freigabe.

## Phase 6 – Abschlusscheckliste

### Geprüfte Actions

| Action | Offizielle Version | Gepinnter Commit-SHA | Offizielle Referenz |
|---|---|---|---|
| `actions/checkout` | `v4.2.2` | `11bd71901bbe5b1630ceea73d27597364c9af683` | [Release](https://github.com/actions/checkout/releases/tag/v4.2.2), [Commit](https://github.com/actions/checkout/commit/11bd71901bbe5b1630ceea73d27597364c9af683) |
| `actions/setup-python` | `v5.6.0` | `a26af69be951a213d495a4c3e4e4022e16d87065` | [Release](https://github.com/actions/setup-python/releases/tag/v5.6.0), [Commit](https://github.com/actions/setup-python/commit/a26af69be951a213d495a4c3e4e4022e16d87065) |

Die Release-Seiten kennzeichnen die Commit-Signaturen als von GitHub verifiziert. Die Workflowberechtigungen sind auf `contents: write` begrenzt, weil der Lauf die zwei Feeddateien committen und pushen soll. Es gibt keine Secrets, keine externen Aktionen außer den beiden gepinnten Official Actions und keine Berechtigungen für Pull Requests, Packages oder Administration.

### Veröffentlichungsfolge nach Freigabe

1. `RonnsenDD/lhh-data-hub` als öffentliches Repository anlegen; keine vorhandenen Repositories importieren oder ändern.
2. Nur die oben dokumentierte Dateiliste übernehmen. Vor dem ersten Push `git diff --cached --stat`, Secret-Scan und Dateiliste prüfen; lokale Umgebungsdateien, Sicherungen, `.git`, Cache-Dateien und interne Leitstelleninhalte ausschließen.
3. `.github/workflows/update-levels.yml.example` im Ziel erst nach Review in `update-levels.yml` überführen. Den Schedule im ersten Veröffentlichungscommit nicht aktivieren, falls der erste Lauf nicht ausdrücklich separat freigegeben ist.
4. Nach Freigabe den ersten Abruf ausführen. Vor Veröffentlichung der JSON-Ausgaben die Felder, Stationsnummern, Zeitstempel und Status kontrollieren. Aktuelle Quelle lieferte im dokumentierten Phase-6-Abruf weiterhin stale Werte; niemals als aktuelle Lage labeln.
5. Nach gesonderter Freigabe den 15-Minuten-Schedule einschalten und den 48-Stunden-Paralleltest ausführen. Alter Feed bleibt unverändert und maßgebliche Rückfallquelle.
6. Nach 48 Stunden Vergleichsprotokoll auswerten. Erst bei erklärten Latenzen/Abweichungen und ohne ungelöste technische Fehler eine separate Freigabe für Verbraucherumstellung einholen.

Der erstmalige öffentliche Push, manuelle Actions-Lauf, Aktivierung des Zeitplans, Umschaltung von Verbrauchern und spätere Stilllegung des alten Feeds sind getrennte Freigabeschritte.
