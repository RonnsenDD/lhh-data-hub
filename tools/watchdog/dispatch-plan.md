# Watchdog: vorbereiteter automatischer Nachstart (nicht aktiviert)

Stand: 31.10.2026. Der Codepfad ist in worker.js und github-app-adapter.js vorbereitet. Im Worker-Standardzustand bleiben GITHUB_APP_READ_ENABLED=false und WORKFLOW_DISPATCH_ENABLED=false. Es gab keine Cloudflare-Bereitstellung, keine Änderung an der GitHub-App, keine Secrets und keinen Workflowstart. Der bestehende Cron */5 * * * * bleibt erhalten.

## Nachgewiesene Datenlücken

GitHub-Historie am 31.10.2026 zeigt beim Wetter geplante Runs mit mehrstündigen Abständen (beispielsweise 15:54:09Z → 19:48:51Z = 3 h 54 min 42 s) und beim Radar 08:20:43Z → 14:36:46Z → 18:44:29Z. In den gezielt geprüften Runs waren die eigentlichen update-weather- beziehungsweise publish-Jobs erfolgreich; ein separat ausgeführter Schedule health-Job schlug bei der Prüfung der Historie fehl. Das belegt Lücken der Schedule-Ereignisse, aber keinen konkreten Grund für deren Ausbleiben. GitHub-Schedule-Ausführung ist best effort; die Audit-Fehler erkennen die Lücke, verursachen sie aber nicht.

## CPU-Befund (Cloudflare-Livewerte und lokale Analyse getrennt)

Read-only aus Cloudflare Workers Observability/Telemetry abgefragt; es wurde kein Worker geändert oder deployt. Für die aktuell beobachtete Version `2a748e33-0cf8-414f-9d1e-e17aea50a31b` wurden am 31.10.2026 UTC 65 `scheduled`-Ereignisse gefunden: CPU p50 12 ms, p90 24 ms, p95 26 ms, Maximum 28 ms. Eine versionsübergreifende Abfrage des Tages ergab 132 Cron-Aufrufe, p50 12 ms, p90 22 ms, p95 26 ms, Maximum 34 ms. Diese Werte sind echte Cloudflare-Messungen; sie liegen über der dokumentierten Free-Grenze von 10 ms je Cron-Aufruf. Der Worker erfüllt daher derzeit **nicht** die Free-CPU-Abnahmebedingung. Das Cloudflare-Kontoabrechnungsmodell beziehungsweise verbleibende Free-Kontingent ließ sich aus den verfügbaren Telemetriedaten nicht bestätigen. Die höheren Werte in p90/p95 verbieten eine Freigabe, selbst wenn der Median künftig sinkt.

Eine Funktions-/Stack-CPU-Aufschlüsselung ist für die bereits deployte Version nicht verfügbar. Das frühere Profil lieferte keine benannten Quellfunktionen. Ursache der 12–28 ms ist deshalb noch nicht kausal zugeordnet; die sieben vollständigen Feed-Downloads sind I/O-Wartezeit und nicht selbst CPU-Zeit. DWD-Wetter ist mit rund 106 KB und 247 MOSMIX-Punkten der deutlich größte geprüfte JSON-Feed. Eine lokale Node.js-24.21.0-Komponentenanalyse mit genau diesem öffentlichen Snapshot (100 Durchläufe) maß für Wetter median/p95: UTF-8-Decodierung 0,018/0,121 ms, JSON-Parsing 0,126/0,167 ms, Auswertung 0,026/0,040 ms. Die sechs anderen Feeds waren kleine Schema-Fixtures, daher sind deren Werte keine Live-Cloudflare-Profile. Diese Messung zeigt, dass der Wetter-Parser unter Node allein die Cloudflare-Überschreitung nicht erklärt; Laufzeit-/Feedanteile auf Cloudflare bleiben offen.

Der lokale End-to-End-Benchmark verwendete 200 Messläufe plus 30 Warm-ups und simulierte alle HTTP-Antworten. Mit dem Live-Wetter-Snapshot (106.189 Bytes) und sechs Schema-Fixtures (zusammen 106.965 Bytes) ergab Node-Prozess-CPU:

| Modus | Ø CPU je Aufruf | Median | p95 | GitHub-Aufrufe je Lauf | Dispatches je Lauf |
| --- | ---: | ---: | ---: | ---: | ---: |
| Flags aus | 0,364 ms | 0,305 ms | 0,617 ms | 0 | 0 |
| GitHub-Leseabfrage simuliert | 1,023 ms | 0,936 ms | 1,365 ms | 6 | 0 |
| Dispatch-Stressfall vollständig simuliert | 1,634 ms | 1,471 ms | 2,284 ms | 8 | 2 |

Das sind ausschließlich Node-Messungen, keine Cloudflare-CPU-Werte und keine realen GitHub-Aufrufe. Der Stressfall veranlasst zwei simulierte Dispatches je Aufruf und zählt keine Netzwerkwartezeit. Der aktuelle Worker hat den Fünf-Minuten-Cron (`*/5 * * * *`); im Telemetriezeitraum gab es keine Änderung dieses Zeitplans. Der neue optionale `WATCHDOG_DIAGNOSTICS_ENABLED`-Schalter kann bei einer später ausdrücklich freigegebenen, zunächst dispatchfreien Messbereitstellung je Feed Fetch-/Body-Wartezeit, Decode-, JSON-Parse- und Auswertungsdauer protokollieren. Diese Stoppuhrwerte sind keine CPU-Profiler-Stacks. Standard ist `false`; aktuelle Live-CPU bleibt ohne eine zulässige spätere Instrumentierung unaufgeschlüsselt.

**Optimierung/Änderung:** Die Wetterauswertung cached die Altersberechnung eines Messproduktes innerhalb des Aufrufs. Das verhindert wiederholtes Parsen desselben Zeitstempels (z. B. Temperatur, Feuchte und Taupunkt). Beim Wetter-Dispatch-Fingerabdruck wird nur der älteste noch veraltete Quellzeitpunkt verwendet; wenn andere Felder aktualisiert werden, während derselbe älteste Wert unverändert bleibt, erzeugt das keinen neuen Snapshot-Fingerabdruck. Es bleibt bei der fachlich konservativen Regel, dass ein einzelnes veraltetes Wetter-Messprodukt den Wetterfeed als `STALE` markieren und einen Kandidaten auslösen kann. Der 30-Minuten-Cooldown, der Fingerabdruck und höchstens zwei Reservierungen/UTC-Tag begrenzen Wiederholungen. Ein Feld wird nicht als aktuell ausgegeben und die Frischegrenze wird nicht verlängert.

## Sichere Triggerlogik

- Nur weather.status === STALE löst update-dwd-weather.yml als Kandidat aus.
- radolan_ry.status === STALE oder konrad3d.status === STALE lösen zusammen höchstens einen Lauf von update-radolan-ry.yml aus.
- ERROR, UNKNOWN, UNAVAILABLE, fehlendes JSON oder ein HTTP-Ausfall erzeugen keinen Dispatch. Sie bleiben Fehler/Unverfügbarkeit und werden nicht als Aktualisierungslücke des Produzenten interpretiert.
- Vor Reservierung und unmittelbar vor Dispatch werden aktive Runs geprüft. Jeder Fehler/Timeout/Rate-Limit der GitHub-API blockiert den Dispatch (fail closed).
- WatchdogDispatchCoordinator ist ein SQLite-backed Durable Object. Es serialisiert Reservierungen pro Workflow, blockiert 30 Minuten nach einem Versuch, merkt sich einen Fingerabdruck der tatsächlich veralteten Quellzeitpunkte (keine Wiederholung bei unverändertem Quellstand) und lässt höchstens zwei Reservierungen pro Workflow/UTC-Tag zu. Fünf-Minuten-Lease verhindert konkurrierende Starts. Unsichere Timeouts behalten die Sperre; keine Retry-Schleife.
- Zulässige Workflows und main sind im Code fest verdrahtet. Es gibt keinen HTTP-Admin-Endpunkt. / und /status bleiben ausschließlich Feedstatus-Endpunkte und lösen keine GitHub-Aktionen aus.
- 204 von GitHub bedeutet nur „Dispatch-Anforderung angenommen“. Ein späterer Erfolg erfordert weiterhin einen neuen Workflowlauf und eine überprüfte Veröffentlichung mit tatsächlichem Quellzeitpunkt; dieser PR behauptet/implementiert keinen erfolgreichen Datenabschluss anhand des Dispatch-Responses.
- Bei `WORKFLOW_DISPATCH_ENABLED=false` protokolliert der Cron veraltete Kandidaten als `workflow_dispatch_observation`; ohne zusätzlich aktiviertes `GITHUB_APP_READ_ENABLED` werden weder GitHub noch das Durable Object angesprochen. Das bleibt Observe-only. Wenn GitHub Read separat eingeschaltet wird, kommen nur Laufstatus-Abfragen dazu; kein Workflowstart.
- RADOLAN-RY und KONRAD3D sind ein gemeinsames Ziel (`update-radolan-ry.yml`), also maximal eine Reservierung und ein Workflowstart für beide Radarquellen pro Kontrolllauf.

## Rechte

Die bestehende GitHub App ist nur auf `RonnsenDD/lhh-data-hub` installiert und hat derzeit `Actions: Read-only`. Nur der spätere `workflow_dispatch`-POST benötigt `Actions: write`. Der Adapter fordert ein kurzlebiges Installationstoken mit genau `repository_ids: [1424581788]` und `{ actions: "write" }` an; zulässige Workflows sind zusätzlich im Code auf DWD-Wetter und das gemeinsame Radar-Workflow festgelegt, Ref ist ausschließlich `main`. Workflow-Listenabfragen fordern separat nur `Actions: read` an. Kein Contents-, Administration- oder Organizations-Zugriff wird angefordert. Der aktuelle PR ändert weder App-Berechtigungen noch Secrets; der Kontoinhaber müsste die App-Berechtigung manuell anheben und Installation aktualisieren, bevor Dispatch technisch möglich wird. Das Secret bleibt im Cloudflare Secret Store.

## Lokaler CPU-Benchmark (Node.js, kein Cloudflare-Messwert)

Am 31.10.2026 mit Node v24.21.0, 20 Warm-up- und 500 Messläufen, 35.259 Fixture-Bytes pro Ausführung, vollständig simulierten HTTP-Antworten:

| Modus | Ø CPU pro Aufruf | Median | p95 | GitHub-Requests/Aufruf | Dispatches/Aufruf |
| --- | ---: | ---: | ---: | ---: | ---: |
| Dispatch aus | 0,227 ms | 0,161 ms | 0,586 ms | 0 | 0 |
| GitHub-Leseprüfung | 0,877 ms | 0,795 ms | 1,198 ms | 6 | 0 |
| Stale-Stressfall, zwei Workflows dispatchen | 1,444 ms | 1,322 ms | 2,166 ms | 8 | 2 |

Der letzte Fall simuliert beide Kandidaten bei jeder Iteration und ignoriert absichtlich die dauerhafte DO-Cooldown-Sperre, damit er ein lokaler Rechen-Stressfall ist. Er zählt keine echten Cloudflare-CPU-Millisekunden, Netzwerk-Wartezeit oder DO-Kontingente. Die echten Livewerte 12–17 ms sind maßgeblich und werden dadurch nicht als unter 10 ms bestätigt.

## Durable Object: Bereitstellung, Sperren und Rückfall

`wrangler.watchdog.jsonc` deklariert das Binding `WATCHDOG_DISPATCH_COORDINATOR`, die Klasse `WatchdogDispatchCoordinator` und die additive SQLite-Klassenmigration `v1-dispatch-coordinator`. Vor Verwendung muss Wrangler diese Migration mit einer regulären Worker-Bereitstellung anwenden; ein manuell eingefügtes Skript allein erzeugt kein Binding. Der Scheduled-Code muss aus dem Namespace über `idFromName("weather-radar-dispatch-v1")` und `get(id)` den stabilen Singleton-Stub holen. Eine Prüfung fand hier einen Defekt: Vorher wurde der Namespace direkt als Stub an `.fetch()` übergeben. Das funktioniert mit echten Cloudflare-Bindings nicht. Der PR löst jetzt den Singleton-Stub korrekt auf und hat dafür einen Regressionstest. Die DO-Klasse verwendet persistenten Storage, `blockConcurrencyWhile`, einen eindeutigen Workflow-Key, Lease, Cooldown, Tageslimit und Quellfingerabdruck; parallele Reservierungen werden im einzelnen Objekt serialisiert. Die automatische Entscheidung für RADOLAN/KONRAD3D bleibt ein gemeinsames Ziel.

Die Migration ist nicht live ausgeführt und weder Persistenz noch Verhalten wurden in einem echten DO nachgewiesen. Tests verwenden einen kontrollierten In-Memory-Storage-Fake; sie belegen die Codepfade, nicht Cloudflare-Persistenz. Rollback: vor allem `WORKFLOW_DISPATCH_ENABLED=false` lassen; falls nach späterer Freigabe zurückgerollt wird, per Worker-Version auf eine kompatible Vorversion zurückstellen und die DO-Bindung/Migrationshistorie erhalten. Die bereits angewandte Klassenmigration nicht durch Entfernen/Umbenennen der Migration rückgängig zu machen. Die Klasse erst in einem separaten, geprüften Lifecycle-Schritt tombstonen/löschen, wenn kein Code sie mehr verwendet. Cloudflare dokumentiert, dass DO-Lifecycleänderungen nicht durch bloßes Zurücksetzen auf eine Version vor der Änderung rückgängig gemacht werden können.

Cloudflare Free dokumentiert Worker Cron CPU von 10 ms/Aufruf; die gemessene laufende Version überschreitet die Grenze. Das verhindert derzeit eine verantwortbare Bereitstellung/Aktivierung. Die DO-Free-Seite dokumentiert Kontingente (100.000 Requests/Tag, 13.000 GB-s/Tag, 100.000 SQL writes/Tag, 5 GB SQLite); die tatsächliche Account-Tarifstufe, die verfügbare DO-Nutzung und mögliche Billing-Überziehungen waren in der verfügbaren Verbindung nicht auswertbar. Kein Namespace, Secret, Binding oder Account-Einstellung wurde live eingerichtet; dies ist keine bestätigte Kostenfreigabe. Bei bezahltem/standard billing oder Kontingentüberschreitung könnten Kosten beziehungsweise Laufzeitfehler entstehen.

## Kontrollierter Freigabeweg

1. **Noch nicht deployen:** zuerst Cloudflare-Kontoinhaber bestätigt tatsächlichen Free-Tarif und DO-Kontingent und die CPU-Überschreitung ist in PR/Code nachvollziehbar unter die 10-ms-Grenze mit Reserve gesenkt. Im Moment ist diese Voraussetzung nicht erfüllt.
2. Bei späterer Freigabe zunächst den Additiv-DO-Binding/Migrationsschritt mit beiden Feature-Flags `false` bereitstellen; Cron `*/5 * * * *` unverändert lassen. Prüfen, dass öffentliche `/` und `/status` unverändert antworten und keine DO-/GitHub-Aufrufe auslösen.
3. 48 Stunden Observe-only: Quellfrische, Cloudflare-CPU (p50/p95/max), Feedstatus und - nach einer kontrollierten Migration - DO-Nutzung beobachten. Optional `WATCHDOG_DIAGNOSTICS_ENABLED=true` für ein begrenztes, dispatchfreies Profilfenster; danach wieder `false`. `GITHUB_APP_READ_ENABLED` bleibt getrennte Entscheidung und gibt nur Lesestatus.
4. Erst nach gesonderter Freigabe: In der App ausschließlich `Actions: write` für diese eine Repository-Installation erlauben; bestehende App-Installation ist ohnehin auf dieses Repository begrenzt. Secret nur als Cloudflare Secret setzen.
5. Für einen kontrollierten Wartungstermin separat Dispatch einschalten. Zuerst einen frischen Feed ohne Auslösung, dann einen einzelnen gezielt veralteten Feed; aktive/wartende Jobs, Cooldown, Snapshot-Dedupe und Tageslimit prüfen. Ein Dispatch zählt erst nach erfolgreichem Workflowlauf, öffentlicher Veröffentlichung und geprüfter Quellzeit als Erfolg.
6. Rückfall: sofort `WORKFLOW_DISPATCH_ENABLED=false`; dadurch wird keine GitHub-Schreibanforderung gestellt. Bei Deploymentregression eine kompatible Worker-Version zurückrollen. Die DO-Migration als Historie beibehalten, bis ein gesonderter sicherer Tombstone-/Entfernungsplan freigegeben ist. Cron nicht deaktivieren.

## Risiken / Abnahmegrenzen

- Der echte Zeitplan bleibt best effort; ein Watchdog kann selbst ausfallen.
- Workflow-API und öffentliche JSON-Feeds können unabhängig voneinander nicht erreichbar sein.
- Es gibt ein unvermeidliches Rennen zwischen der zweiten Active-Run-Abfrage und GitHub-Annahme; Actions concurrency bleibt die letzte Ausführungssperre.
- Ein 204 beweist nicht, dass der Runner startete oder ein frisches Produkt veröffentlichte.
- Current live CPU p50 12 ms / p95 26 ms / max 28 ms exceeds documented 10 ms. Keine Deployment- oder Dispatch-Freigabe, bis die Ursache genauer belegt und die reale CPU mit deutlichem Headroom unter 10 ms liegt; die niedrigen Node-Werte reichen hierfür nicht.
- Bis mehrere automatische Datenzyklen nach Live-Aktivierung erfolgreich sind, wird keine Zuverlässigkeitsgarantie ausgesprochen.

## Referenzen

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event
