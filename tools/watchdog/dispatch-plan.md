# Watchdog: vorbereiteter automatischer Nachstart (nicht aktiviert)

Stand: 31.10.2026. Der Codepfad ist in worker.js und github-app-adapter.js vorbereitet. Im Worker-Standardzustand bleiben GITHUB_APP_READ_ENABLED=false und WORKFLOW_DISPATCH_ENABLED=false. Es gab keine Cloudflare-Bereitstellung, keine Änderung an der GitHub-App, keine Secrets und keinen Workflowstart. Der bestehende Cron */5 * * * * bleibt erhalten.

## Nachgewiesene Datenlücken

GitHub-Historie am 31.10.2026 zeigt beim Wetter geplante Runs mit mehrstündigen Abständen (beispielsweise 15:54:09Z → 19:48:51Z = 3 h 54 min 42 s) und beim Radar 08:20:43Z → 14:36:46Z → 18:44:29Z. In den gezielt geprüften Runs waren die eigentlichen update-weather- beziehungsweise publish-Jobs erfolgreich; ein separat ausgeführter Schedule health-Job schlug bei der Prüfung der Historie fehl. Das belegt Lücken der Schedule-Ereignisse, aber keinen konkreten Grund für deren Ausbleiben. GitHub-Schedule-Ausführung ist best effort; die Audit-Fehler erkennen die Lücke, verursachen sie aber nicht.

## CPU-Befund

Der Livebetrieb meldete zuvor 12–17 ms CPU je Cron-Ausführung bei deaktivierter GitHub-App. Cloudflare dokumentiert für Workers Free 10 ms CPU pro Aufruf. Ein 50-Sekunden-CPU-Profil des bestehenden Workers wurde aufgenommen, enthielt jedoch keine aufrufbaren Quellfunktionsnamen (nur root/GC/idle-Samples); daraus lässt sich kein einzelner Hotspot belegen. Der Quellpfad liest, decodiert und parst sieben vollständige JSON-Feeds pro Cron-Lauf; dies ist ein plausibler Arbeitsanteil, aber keine kausal gemessene Zuordnung. Die App-Observation kann bei deaktiviertem Flag nicht die Ursache des 12–17-ms-Baselineverbrauchs sein. Der Nachstartpfad bleibt default-off und kann daher den derzeitigen Liveverbrauch nicht reduzieren. Lokale Node-Benchmarks sind keine Cloudflare-CPU-Messung. Der Free-CPU-Headroom ist vor Aktivierung erneut live zu messen.

## Sichere Triggerlogik

- Nur weather.status === STALE löst update-dwd-weather.yml als Kandidat aus.
- radolan_ry.status === STALE oder konrad3d.status === STALE lösen zusammen höchstens einen Lauf von update-radolan-ry.yml aus.
- ERROR, UNKNOWN, UNAVAILABLE, fehlendes JSON oder ein HTTP-Ausfall erzeugen keinen Dispatch. Sie bleiben Fehler/Unverfügbarkeit und werden nicht als Aktualisierungslücke des Produzenten interpretiert.
- Vor Reservierung und unmittelbar vor Dispatch werden aktive Runs geprüft. Jeder Fehler/Timeout/Rate-Limit der GitHub-API blockiert den Dispatch (fail closed).
- WatchdogDispatchCoordinator ist ein SQLite-backed Durable Object. Es serialisiert Reservierungen pro Workflow, blockiert 30 Minuten nach einem Versuch, merkt sich einen Fingerabdruck der tatsächlich veralteten Quellzeitpunkte (keine Wiederholung bei unverändertem Quellstand) und lässt höchstens zwei Reservierungen pro Workflow/UTC-Tag zu. Fünf-Minuten-Lease verhindert konkurrierende Starts. Unsichere Timeouts behalten die Sperre; keine Retry-Schleife.
- Zulässige Workflows und main sind im Code fest verdrahtet. Es gibt keinen HTTP-Admin-Endpunkt. / und /status bleiben ausschließlich Feedstatus-Endpunkte und lösen keine GitHub-Aktionen aus.
- 204 von GitHub bedeutet nur „Dispatch-Anforderung angenommen“. Ein späterer Erfolg erfordert weiterhin einen neuen Workflowlauf und eine überprüfte Veröffentlichung mit tatsächlichem Quellzeitpunkt; dieser PR behauptet/implementiert keinen erfolgreichen Datenabschluss anhand des Dispatch-Responses.

## Rechte

Die bestehende GitHub App ist nur auf RonnsenDD/lhh-data-hub installiert und hat derzeit Actions: Read-only. Für den vorbereiteten POST /repos/RonnsenDD/lhh-data-hub/actions/workflows/{file}/dispatches benötigt die Installation Actions: write. Ein Installationstoken wird auf die einzelne Repository-ID 1424581788 und ausschließlich Actions write angefordert; keine Contents-, Administration- oder Organizations-Rechte. Die Einstellung wird in diesem PR nicht geändert. Der Kontoinhaber müsste die App-Berechtigung manuell anheben und die bestehende Installation aktualisieren. Der Private Key bleibt ein Cloudflare-Secret.

## Lokaler CPU-Benchmark (Node.js, kein Cloudflare-Messwert)

Am 31.10.2026 mit Node v24.21.0, 20 Warm-up- und 500 Messläufen, 35.259 Fixture-Bytes pro Ausführung, vollständig simulierten HTTP-Antworten:

| Modus | Ø CPU pro Aufruf | Median | p95 | GitHub-Requests/Aufruf | Dispatches/Aufruf |
| --- | ---: | ---: | ---: | ---: | ---: |
| Dispatch aus | 0,227 ms | 0,161 ms | 0,586 ms | 0 | 0 |
| GitHub-Leseprüfung | 0,877 ms | 0,795 ms | 1,198 ms | 6 | 0 |
| Stale-Stressfall, zwei Workflows dispatchen | 1,444 ms | 1,322 ms | 2,166 ms | 8 | 2 |

Der letzte Fall simuliert beide Kandidaten bei jeder Iteration und ignoriert absichtlich die dauerhafte DO-Cooldown-Sperre, damit er ein lokaler Rechen-Stressfall ist. Er zählt keine echten Cloudflare-CPU-Millisekunden, Netzwerk-Wartezeit oder DO-Kontingente. Die echten Livewerte 12–17 ms sind maßgeblich und werden dadurch nicht als unter 10 ms bestätigt.

## Cloudflare-Voraussetzungen und Kosten

Der PR ergänzt eine SQLite-backed DO-Binding/Migration und setzt beide Schalter in der Wrangler-Konfiguration auf false. Vor einem Deploy muss der Kontoinhaber im Cloudflare-Konto den Workers-Plan und das verbleibende DO-Kontingent bestätigen. Free hat dokumentierte Kontingente, aber das Konto/Tarif und die aktuelle Auslastung waren nicht live bestätigt; dies ist daher keine Kostenfreigabe. Bei Paid/Standard Billing oder Überschreitung können Gebühren entstehen beziehungsweise weitere Vorgänge fehlschlagen. Kein Namespace, Secret oder Binding wurde live eingerichtet. Die Datei wrangler.watchdog.jsonc beschreibt die SQLite-Migration; sie muss mit Wrangler bereitgestellt werden, bevor der Worker das DO-Binding verwenden kann.

## Kontrollierter Freigabeweg

1. Erst nach getrennten Freigaben in Cloudflare den DO-SQLite-namespace migrieren/binden und den Worker mit beiden Schaltern false deployen. Cron unverändert lassen.
2. 48 Stunden Observe-only: Quellfrische, CPU, Feedstatus und DO-Metriken beobachten. App-Lesezugriff kann getrennt aktiviert werden; er führt nie Dispatch aus.
3. Nutzer-/Kontoinhaber prüft GitHub-App-Berechtigung, dann Actions: write nur für diese Repository-Installation. Secret bleibt im Cloudflare-Secret Store.
4. Simulierte Dispatch-Tests dieses PRs und ein kontrollierter Wartungs-/Freigabetermin vorausgesetzt, separat WORKFLOW_DISPATCH_ENABLED=true genehmigen. Nicht durch öffentliche Requests änderbar.
5. Beobachten, dass kein frischer Feed ausgelöst wird; veralteter Feed genau einen Lauf erlaubt; aktive und wartende Runs gesperrt werden; anschließende Veröffentlichung samt Quellzeit geprüft wird. Sofortiger Rückfall: Flag false.

## Risiken / Abnahmegrenzen

- Der echte Zeitplan bleibt best effort; ein Watchdog kann selbst ausfallen.
- Workflow-API und öffentliche JSON-Feeds können unabhängig voneinander nicht erreichbar sein.
- Es gibt ein unvermeidliches Rennen zwischen der zweiten Active-Run-Abfrage und GitHub-Annahme; Actions concurrency bleibt die letzte Ausführungssperre.
- Ein 204 beweist nicht, dass der Runner startete oder ein frisches Produkt veröffentlichte.
- Current live CPU 12–17 ms exceeds documented 10 ms. Keine Produktionsfreigabe, bis mehrere reale Cloudflare-Messungen ausreichenden Headroom belegen.
- Bis mehrere automatische Datenzyklen nach Live-Aktivierung erfolgreich sind, wird keine Zuverlässigkeitsgarantie ausgesprochen.

## Referenzen

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event
