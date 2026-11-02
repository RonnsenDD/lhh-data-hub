# Variant B: isolierter Monitor und Dispatcher (Prototyp)

Dieser Entwicklungszweig enthält einen rein lokalen Entscheidungsprototyp. Er ist kein deploybares Worker-Artefakt und führt weder GitHub- noch Cloudflare-Aufrufe aus.

## Zielgrenze

- Der Monitoring-Worker behält die vorhandenen öffentlichen Statusfunktionen und die bisherigen sieben Feedprüfungen. Sein Cronpfad überwacht weiterhin nur DWD-Wetter-Sidecar, RADOLAN-RY und KONRAD3D.
- Nur nach erfolgreichem Feedabruf und anhand tatsächlicher Mess-/Produktzeiten kann der Monitor einen begrenzten Kandidaten an den Dispatcher über ein Cloudflare Service Binding übergeben.
- Der Dispatcher hat keine öffentliche Route und kein `workers.dev`-Hostname; erreichbar ist er nur über das Service Binding. Im Worker-Deployment dürfen keine Routen für den Dispatcher konfiguriert werden.
- Nur der Dispatcher erhält später den GitHub-App-Private-Key. Ein Installationstoken muss auf `RonnsenDD/lhh-data-hub` und Actions-Rechte beschränkt werden. GitHub erteilt Actions-Schreibrechte auf Repository-Ebene; die Workflow-Allowlist begrenzt zusätzlich das Verhalten des Codes, ist aber keine GitHub-Berechtigungsgrenze.
- Feste Ziele: Wetter `update-dwd-weather.yml`; Radar (beide Produkte gemeinsam) `update-radolan-ry.yml`. Keine vom Aufrufer gelieferten Workflowdateien oder Refs akzeptieren.
- Kein Abrufzeitpunkt und kein `derivedAt` darf einen Quellzeitpunkt ersetzen. Fehlt ein Quellzeitpunkt, ist der Status fehlerhaft/unbekannt oder ist ein Guard nicht erreichbar, wird nicht ausgelöst.
- Vor jeder späteren Dispatch-Implementierung müssen aktiver Lauf, Cooldown, Tagesquote und atomare Lease nachgewiesen sein. Ein unklarer Dispatch-Timeout gilt als unbekannt und darf keine automatische Wiederholung auslösen.

## CPU- und Kontingentfolgen

Ein Service Binding fügt im Workers Standard-Modell keine zusätzliche Requestgebühr hinzu, zählt aber als Subrequest. Cloudflare addiert CPU beider Worker zum selben Aufruf. Daher trennt ein Service Binding Secrets und Code, aber nicht das 10-ms-Free-CPU-Budget.

Ein eigener Dispatcher-Cron würde eine separate CPU-Ausführung schaffen, aber bei einer unabhängigen 15-Minuten-Prüfung zusätzliche Datenabrufe erzeugen. Der Account hat bei der letzten lesenden Cloudflare-Abfrage drei Worker und zwei aktive Cron-Trigger (`*/5` Watchdog, `*/30` Testworker); der Pegel-Pilot hat keinen Cron. Mit einem zusätzlichen Cron wären drei von maximal fünf Triggern belegt. Diese Architektur ist nicht vorbereitet oder deployed.

## Modellrechnung (nur bekannte geplante Aufrufe)

Zwei Datenworkflows alle 15 Minuten bedeuten 2 × 96 × 30 = 5.760 Runs je 30 Tage. Bei einer CI-Minute je Run sind das 5.760 Runner-Minuten, ohne Checkout, Retries oder sonstige CI-Jobs.

- Aktueller Cloudflare-Bestand: Produktions-Watchdog `*/5` = 288 Cronläufe/Tag; Testworker `*/30` = 48/Tag; zusammen 10.080/30 Tage. Bei drei Feed-GETs je Lauf: 30.240 Feedabrufe/30 Tage, ohne externe öffentliche Statusaufrufe und Redirects.
- Ein Dispatcher, der intern nur bei stale Kandidaten aufgerufen wird, fügt keinen regelmäßigen Quellabruf hinzu. CPU bleibt jedoch aggregiert.
- Ein eigener `*/5`-Dispatcher-Cron wäre zusätzlich 8.640 Cronläufe/30 Tage und würde bei drei Feedabrufen pro Lauf 25.920 weitere GETs/30 Tage erzeugen.

Diese Werte sind keine Billing-Messung und keine Garantie für tatsächliche Ausführungszeiten.

## Lokale Tests

`node --test tools/watchdog/dispatcher-prototype.test.mjs` prüft ausschließlich den side-effect-freien Kandidatenfilter. Live-Dispatch, Service-Binding-Latenz, Durable-Object-Kontingente und Cloudflare-CPU sind nicht getestet.
