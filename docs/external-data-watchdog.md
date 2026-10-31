# Unabhängiger Data-Hub-Watchdog (Entwurf)

Der Ordner `tools/watchdog/` enthält einen noch nicht aktivierten Cloudflare-Worker-Entwurf für die fünf bestehenden Workflows in RonnsenDD/lhh-data-hub. Er liest Feed- und GitHub-Status. Nur nach gesonderter Freigabe kann er bestehende Workflows über workflow_dispatch anstoßen.

## Sicherheitszustand

- Standard ist WATCHDOG_MODE=observe und DISPATCH_ENABLED=false.
- Es gibt keinen fetch-Handler, keine Route und keinen öffentlich aufrufbaren Auslösendpunkt. workers_dev=false ist im Wrangler-Beispiel gesetzt.
- Kein Cloudflare-Konto, Worker, D1-Datenbank, GitHub-App, Secret oder Token wird durch diesen PR eingerichtet.
- Die bestehenden GitHub-Schedules bleiben aktiv; kein Produktionsworkflow wird geändert oder gestartet.
- Bei fehlender D1-Sperre, GitHub-API-Fehlern, deaktiviertem Workflow oder unklarem Feedstatus wird nicht dispatcht. Enthält ein Workflow mehrere Feeds, muss jeder davon lesbar und auswertbar sein, bevor ein Dispatch zulässig ist. Kann der Commitzeitpunkt einer Raw-JSON nicht nachgewiesen werden, markiert das Monitoring die Publikation als ungeklärt und blockiert den Dispatch. Enthält ein Workflow mehrere Feeds, muss jeder davon lesbar und auswertbar sein, bevor ein Dispatch zulässig ist.
- Der Worker schreibt weder in SharePoint noch in die erzeugten Feeddateien.

## Aufbau

- worker.mjs: Scheduled-Handler, GitHub-App-JWT/Installationstoken, Statusadapter, Backoff und Dispatch-Gates.
- migrations/0001_init.sql: D1-Free-Statusspeicher, eindeutige Sperre je Workflow, API-Backoff und minimales Ereignisprotokoll.
- watchdog.test.mjs: Node-Testlauf mit gefälschten HTTP- und D1-Schnittstellen.
- test_dispatch_guard_sql.py: führt das aus worker.mjs extrahierte Sperr-SQL gegen SQLite aus; prüft Cooldown und Tageslimit.
- wrangler.watchdog.jsonc: beispielhafte 5-Minuten-Konfiguration ohne echte Konto- oder Datenbank-ID.

Der Worker prüft bei jedem Lauf den GitHub-Default-Branch und die Registrierung/Aktivierung der Workflows, lädt je Workflow bis zu 100 Läufe und liest die sieben unabhängigen JSON-Feeds. Die getrennten Workflowabfragen verhindern, dass häufige Wetter-/Radarläufe die tägliche Historie für Grasland oder Waldbrand aus der jüngsten 100er-Auswahl verdrängen. Der Worker dispatcht nur, wenn der Default-Branch weiterhin main ist.

## Geprüfte bestehende Zeitpläne und Frischegrenzen

Alle Cron-Zeiten sind UTC. Schwellen entsprechen dem lokalen DesignTest-Code, soweit dort eine fachliche Frischeprüfung vorhanden ist.

| Workflow | GitHub-Zeitplan | Überwachte Datei(en) | Quellzeit / Dashboardgrenze | Grace | Mindestabstand / Tageslimit |
| --- | --- | --- | --- | --- | --- |
| update-dwd-weather.yml | :03, :18, :33, :48 jede Stunde | dwd-weather.json | DWD-Messzeiten höchstens 45 min; MOSMIX-Ausgabe höchstens 12 h | 30 min | 60 min / 3 |
| update-levels.yml | :11, :26, :41, :56 jede Stunde | pegel-lauchhammer.json, pegel-biehlen-1.json | measuredAtUtc höchstens 45 min; retrievedAt wird nicht als Messzeit verwendet | 30 min | 60 min / 3 |
| update-radolan-ry.yml | :07, :22, :37, :52 jede Stunde | RADOLAN latest.json, KONRAD3D latest.json | productTime bzw. referenceTime höchstens 15 min | 30 min | 60 min / 3 |
| update-graslandfeuerindex.yml | täglich 05:15 | graslandfeuerindex.json | dataAsOf höchstens 36 h und Tageswert für Europe/Berlin vorhanden | 120 min | 360 min / 1 |
| update-waldbrandgefahrenstufe-osl.yml | täglich 07:20 | waldbrandgefahrenstufe-osl.json | sourceDate muss im offiziellen 08:00–08:00-Intervall Europe/Berlin liegen | 60 min | 360 min / 1 |

Quellfrische wird unabhängig von einem erfolgreichen Workflowlauf berechnet. Die Waldbrandbewertung ignoriert das gespeicherte Statusfeld und prüft sourceDate. Bei Datenfehler oder fehlender Messzeit wird kein aktueller Status erfunden.

Die aktuelle öffentliche JSON-Datei enthält nicht für jeden Feed eine belastbare Veröffentlichungszeit. Der Bericht trennt deshalb sourceTimestamp, Quellalter (bei Waldbrand ab 08:00 Europe/Berlin), retrievedAt/lastAttemptAt und publishedAt. Für Raw-JSONs ist publishedAt der letzte Commitzeitpunkt des konkreten JSON-Pfads aus der GitHub-Commits-API; dafür ist Contents:read erforderlich. Für RADOLAN/KONRAD3D wird wegen GitHub Pages statt eines Dateicommitzeitpunkts der letzte erfolgreiche Abschluss nach öffentlicher URL-Verifikation als lastPublicVerificationAt ausgewiesen. Das ist der Bestätigungszeitpunkt, kein behaupteter exakter Veröffentlichungszeitpunkt. Der Abschluss des Workflows ist kein Beweis für neue Quelldaten.

## Statusmodell

Jede der sieben Datenquellen erhält einen Datensatz in watchdog_status:

- aktuell: Quellzeit innerhalb der fachlichen Frische-/Gültigkeitsgrenze.
- veraltet: Quelldatei lesbar, aber Quellzeit außerhalb der Grenze oder notwendiges Feld fehlt.
- Abruf fehlgeschlagen: Feed-HTTP-/JSON-Fehler oder letzter Produzentenlauf fehlgeschlagen.
- Automatik ausgefallen: Workflow deaktiviert/nicht registriert, überfälliger Schedule-Slot oder nachgewiesene Zeitplanlücke.

Zusätzlich enthält detail_json letzte manuelle/automatische Workflowstarts und Ergebnisse, aktiven Status, Schedule-Slot, Startverzögerung, Abstand zwischen den letzten automatischen Läufen, sourceTimestamp, retrievedAt, publishedAt (wenn geliefert), lastSuccessfulAt, Datenalter, Fehlergrund, Dispatch-Modus/-Entscheidung, Cooldown und nextAllowedDispatchAt. Ein fehlender Workflow wird nicht automatisch aktiviert.

Eine GitHub-API-Störung setzt einen persistenten Backoff; im Backoff findet kein weiterer GitHub-Aufruf und kein Dispatch statt. HTTP-429, 403, 5xx und Netzwerkfehler werden nicht aggressiv wiederholt. Eine Feed-HTTP-Störung allein startet keinen Produzenten: dafür muss ein echter stale Feed, ein fehlender Schedule-Slot oder ein fehlgeschlagener Producer vorliegen.

## Doppelstartschutz

Die Sperre liegt in D1 Free (nicht in eventual-consistency KV). Ein SQLite-Upsert mit UNIQUE/PRIMARY KEY je workflow_key und RETURNING beansprucht die Sperre atomar. Das einzelne Claim-Statement setzt gleichzeitig Mindestabstand, UTC-Tageszähler und Lease. Claim-Fehler oder D1-Ausfall verhindern den Dispatch. Bei erfolgreicher oder unklar fehlgeschlagener Dispatch-Anfrage bleibt die Sperre bis zum Mindestabstand bestehen; ein Timeout kann daher einen Wiederanstoß verzögern, vermeidet aber Doppelstarts. Ein laufender/queued GitHub-Run blockiert zusätzlich.

Dispatch ist doppelt gesperrt: WATCHDOG_MODE muss dispatch und DISPATCH_ENABLED muss exakt true sein. Beide bleiben standardmäßig ausgeschaltet. Der Workflow muss in der REST-API als aktiv vorhanden sein; der Watchdog schaltet keinen Workflow um.

## Berechtigungen

Die GitHub-App wird später ausschließlich für RonnsenDD/lhh-data-hub installiert:

1. Beobachtungsmodus: GitHub-App-Installation auf genau `RonnsenDD/lhh-data-hub` mit Repository-Rechten Actions read und Contents read. Contents read wird ausschließlich für den letzten Commitzeitpunkt jeder Raw-JSON-Datei verwendet. Kein Contents write, Administration-, Organization- oder SharePoint-Recht.
2. Auslösemodus nach separater Freigabe: Repository Actions write, weil die Workflow-dispatch-REST-API dieses Recht benötigt. GitHub bietet für diese App-Berechtigung keine Beschränkung auf einzelne Workflowdateien; Actions write gilt für das gesamte installierte Repository. Der Code dispatcht nur die fünf fest konfigurierten Dateien. Die breitere Repositorywirkung ist ein verbleibendes Risiko. Kein Schreibzugriff auf Contents.
3. Installation auf genau dieses Repository beschränken. Installation-ID, App-ID und private PEM ausschließlich in Cloudflare-Konfiguration/Secret Store; keine Werte in Git, Worker-Logs, D1 oder Browser.
4. Der Worker erstellt kurzlebige Installationstokens pro Lauf und verwirft sie im Speicher. JWT und Token werden nie ausgegeben oder protokolliert.

Die im Code verwendete GitHub REST-API fragt Workflowzustand und Workflowläufe ab; dispatcht wird nur auf main und nur über den bestehenden Workflowdateinamen. `Actions: write` ist eine repositoryweite Berechtigung, keine workflowbezogene Einschränkung.

## Kosten- und Free-Tier-Prüfung (31.10.2026)

Die aktuelle Cloudflare-Dokumentation nennt für Workers Free 100.000 Requests pro Tag, 10 ms CPU je Cron-Aufruf, maximal fünf Cron-Trigger pro Konto und 50 Subrequests pro Invocation. Ein Fünf-Minuten-Cron sind 288 Aufrufe pro Tag. Ein Kontrolllauf führt typischerweise sieben Feedabrufe, fünf Metadaten-Commits, eine Repositoryabfrage, eine Workflowliste, fünf getrennte Workflowlaufabfragen und eine Tokenanforderung aus (20 Subrequests). Selbst mit maximal fünf Dispatches bleibt er bei etwa 25 von 50 Subrequests. Das sind rund 156 authentifizierte GitHub-API-Aufrufe pro Stunde, zusätzlich zu den Feedabrufen, plus wenige Dispatches; API-Rate-Limit-Header und 403/429 werden überwacht, und ein gemeinsamer Backoff verhindert Wiederholungsstürme. Das Free-Konto erlaubt höchstens fünf Cron-Trigger insgesamt; vorhandene Kontoauslastung muss vor Einrichtung geprüft werden.

D1 Free umfasst aktuell 5 Mio. Zeilenreads pro Tag, 100.000 Zeilenwrites pro Tag und 5 GB Gesamtspeicher. Bei sieben Statuszeilen pro Tick sind etwa 2.016 Status-Upserts pro Tag zu erwarten, plus begrenzte Ereignisse. D1 Free-Anfragen schlagen nach Erreichen des täglichen Read-/Write-Limits fehl; das System wechselt dann in Fail-Closed und dispatcht nicht. Kein automatisches Upgrade und kein Paid-Plan vorsehen.

Monatliche direkte Cloudflare-Gebühr: 0 USD, sofern ausschließlich Workers Free und D1 Free innerhalb ihrer Limits benutzt werden. GitHub-Gebühr: keine zusätzliche Runner-Ausführung durch den Worker selbst; ein Dispatch kann einen vorhandenen Actions-Lauf starten und dessen übliche Repository-Minuten beanspruchen. Keine kostenpflichtigen Runner aktivieren.

Wichtiger ungeklärter Free-Tier-Risikopunkt: Cloudflare Free begrenzt Cron-Code auf 10 ms CPU. Die App-JWT-Erzeugung, RSA-Signatur und das Parsen der etwa 100-KB-Wetterdatei wurden nur lokal in Node geprüft. Es gibt keinen Worker-/Free-Runtime-Messwert. Vor einem 48-Stunden-Test ist ein isolierter Free-Account-CPU-Probelauf erforderlich. Wenn reproduzierbar mehr als 10 ms benötigt werden, wird nicht auf Paid umgestellt; der Entwurf gilt bis zu einer neuen kostenfreien Option als nicht einsatzbereit.

Cloudflare Cron läuft nach UTC und verwendet laut Dokumentation unterausgelastete Maschinen. Für einen harten Verfügbarkeits-SLA ist damit kein Nachweis erbracht. GitHub bleibt weiter selbst eine Abhängigkeit für Runstatus und Datenverarbeitung. Der Watchdog kann Netzwerk-, D1-, GitHub- oder Cloudflare-Ausfälle nicht selbstständig melden, wenn seine eigene Laufzeit nicht ausgeführt wird.

## Einrichtung nach PR-Prüfung und separater Freigabe

Keine der folgenden Handlungen wurde ausgeführt.

1. Cloudflare-Konto/Workers Free und Wrangler lokal prüfen; vorab bestätigen, dass kein Paid-Plan erforderlich ist und keine automatische Umstellung auf Paid aktiviert wird.
2. In GitHub eine App anlegen und auf genau das Repository installieren. Zunächst Actions read konfigurieren; für den Beobachtungsmodus werden keine weiteren Repositoryrechte benötigt. Für Beobachtung kann DISPATCH_ENABLED=false bleiben; App-ID und Installation-ID lokal in die ungetrackte Wrangler-Datei übernehmen.
3. Aus der `wrangler.watchdog.jsonc`-Vorlage eine private Wrangler-Konfiguration erzeugen. Keine tatsächlichen IDs in diesen PR committen. D1 Free erstellen, die ausgegebene database_id nur lokal in die Konfiguration eintragen und migrations/0001_init.sql anwenden.
4. GH_APP_PRIVATE_KEY mit Wrangler als Secret setzen. Das PEM nicht in einer Shell-Historie, einem öffentlichen Log, Commit oder D1 speichern. Prüfen, dass der Key niemals in wrangler tail erscheint.
5. WATCHDOG_MODE=observe und DISPATCH_ENABLED=false beibehalten; Worker ausschließlich mit scheduled handler veröffentlichen, workers.dev deaktiviert lassen und keinen Route-Eintrag anlegen.
6. Eine Stunde beobachten: 12 Tick-Einträge über checked_at, alle sieben Feedzeilen, API-Rate-/CPU-Metriken, D1-Rows Read/Written, keine Dispatch-Events. Bei fehlendem Status, CPU-Limit oder API-Fehler nicht fortfahren.
7. Danach einen 48-Stunden-Beobachtungstest starten. Mindestabnahme: 576 erwartete Ticks, mindestens 570 vollständige Statuschecks (99 %), alle fünf Workflowzustände je Check, sieben Datenquellenzeilen, keine Feedklassifizierung allein aus retrievedAt, zero Dispatches, keine D1-Limitfehler, keine Token-/Schlüsselleaks, Cron-CPU dauerhaft unter 10 ms (Ziel p99 höchstens 8 ms). Zwei getrennte Quellenzeitpunkte und der tägliche Europe/Berlin-Tageswechsel müssen beobachtet oder mit Fixtures validiert sein.
8. Dispatch bleibt nach diesen Tests aus. Für die Aktivierung braucht es eine neue ausdrückliche Freigabe. Dann: GitHub-App-Berechtigung auf Actions write erhöhen und Installation erneut genehmigen; Contents read bleibt ebenfalls erforderlich; den erhöhten Modus ausstellen; nach einer begrenzten kontrollierten Testfreigabe eine separate Freigabe einholen, erst dann WATCHDOG_MODE=dispatch und DISPATCH_ENABLED=true setzen. Per-Workflow-Limit: höchstens drei Dispatches/UTC-Tag für die drei 15-Minuten-Produzenten, höchstens einer/UTC-Tag für beide Tagesproduzenten.
9. Abschalten: zuerst DISPATCH_ENABLED=false setzen, danach Cron Trigger entfernen/deaktivieren. GitHub-Schedules und Produzenten bleiben aktiv. D1 Status/Logs lesend exportieren; kein Datensatz muss in Git verbleiben.

## Lokale Prüfung

Node.js 20+:

    node --test tools/watchdog/watchdog.test.mjs

Python 3:

    python3 -m unittest discover -s tools/watchdog -p 'test_*.py' -v

Wrangler-Dry-Run/Free-CPU-Test ist vor der Einrichtung nicht möglich. Vor tatsächlicher Aktivierung muss die JSONC-Konfiguration mit der dann aktuellen Wrangler-Version validiert werden. Der Entwurf ist nicht produktiv freigegeben.
