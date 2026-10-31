# Watchdog V2: sicherer GitHub-Nachstart (Plan, nicht implementiert)

Stand: 31.10.2026. Dies ist ein Architekturplan für eine spätere, gesondert freizugebende Funktion. Der Worker in `worker.js` bleibt observe-only: keine GitHub-API, keine Dispatches, keine Zugangsdaten.

## Entscheidung zur Sperre

Ein zustandsloser Cron-Worker kann parallele Ausführungen nicht zuverlässig gegen doppelte Dispatches sperren. Für den Nachstart braucht es eine atomare, persistente Reservierung.

Cloudflare SQLite-backed Durable Objects sind laut Cloudflare-Dokumentation im Workers Free-Tarif verfügbar. Für Free gelten derzeit 100.000 DO-Requests/Tag, 13.000 GB-s Laufzeit/Tag, 5 Mio. SQL-Zeilenlesevorgänge/Tag, 100.000 Schreibvorgänge/Tag und 5 GB Speicher. Free-Limits werden täglich zurückgesetzt; bei Überschreitung schlagen weitere Operationen fehl. Auf einem Paid-Tarif gelten andere Inklusivmengen und mögliche Mehrkosten. Daher darf diese Architektur erst aktiviert werden, wenn im tatsächlichen Konto Workers Free und genügend Restkontingent bestätigt sind. Das Cloudflare-Connector-Konto dieser Prüfung zeigte keine Accounts; Tarif, aktuelle Nutzung und Restkontingent sind damit **nicht live bestätigt**.

Bei einem einzigen Coordinator-Objekt kann ein SQLite-Unique-Key pro Workflow mit atomarem `INSERT … ON CONFLICT … WHERE lease_expired RETURNING` die Reservierung bilden. Der Netzwerkaufruf an GitHub erfolgt erst nach der Reservierung und außerhalb einer DB-Transaktion. Ein DO-Quota- oder Speicherfehler muss „kein Dispatch“ bedeuten (fail closed). Ein bloßes Worker-globales `Map`, Cache API oder KV-Read-then-Write ist keine ausreichende Sperre.

Ein 5-Minuten-Cron bedeutet 288 Watchdog-Prüfungen/Tag. Ein globaler Coordinator-Aufruf pro Lauf wären etwa 288 DO-Requests/Tag, zuzüglich seltene Reservierungsänderungen; das liegt rechnerisch unter den dokumentierten Free-Grenzen, beweist aber weder Konto-Restkontingent noch CPU-Headroom. Der bestehende Worker prüft sieben Feeds (sieben ausgehende Feed-Requests pro Durchlauf, begrenzt parallel auf vier); für Free gilt außerdem 10 ms CPU je Worker-Aufruf und 50 Subrequests je Aufruf. CPU und Kontonutzung konnten live nicht geprüft werden.

## Zielablauf für eine spätere Dispatch-Ausbaustufe

1. Der bestehende Cron prüft weiter alle sieben öffentlichen JSON-Feeds anhand ihrer Mess-/Produktzeit. Nur Quelle `STALE` oder bestätigter Produzentenfehler ist ein Kandidat; Abrufzeit/HTTP-Erfolg aktualisiert keine Messzeit.
2. Ein einziger Coordinator-Aufruf prüft und reserviert atomar pro zulässiger Workflowdatei. Vor der Reservierung werden Status-API-Ausfälle, offene Cooldowns, Tageslimit, aktiver Lauf und zuletzt beobachtete Veröffentlichung berücksichtigt.
3. Der Worker fragt GitHub für den fest verdrahteten Workflow-Laufstatus ab. Bei laufendem oder wartendem Job: kein Dispatch. Bei HTTP 403/429/5xx, Rate-Limit oder uneindeutiger Antwort: kein Dispatch; Rate-Limit-Header beachten und begrenzte Sperre beibehalten.
4. Erst nach einer atomaren Kurzzeit-Reservierung wird der vorhandene Workflow mit `workflow_dispatch` angefordert. Die Reservierung wird vor dem HTTP-Aufruf persistiert. Bei Timeout bleibt ein Cooldown bestehen, weil GitHub den Start möglicherweise angenommen hat.
5. HTTP 204 bedeutet nur „Dispatch-Anforderung angenommen“, niemals „Daten aktualisiert“. Der Worker wartet auf einen neuen `workflow_dispatch`-Run, ermittelt dessen Abschluss und prüft danach erneut den öffentlichen Feed und dessen tatsächlichen Quellzeitpunkt. Erst eine erfolgreiche Veröffentlichung mit fachlich aktueller Quelle gilt als aktualisiert.
6. Bei nicht beobachtbarem Run oder unverändertem Feed: Status `dispatch_requested`/„Ausführung oder Datenaktualisierung nicht bestätigt“, begrenzte Wiederholungssperre und Störungsausgabe; kein Fünf-Minuten-Dauernachstart.

### Sicherheits- und Betriebsgrenzen

- Zulässige Dateien sind eine im Code fest verdrahtete Liste: `update-dwd-weather.yml`, `update-levels.yml`, `update-radolan-ry.yml`, `update-graslandfeuerindex.yml`, `update-waldbrandgefahrenstufe-osl.yml`. Keine vom HTTP-Aufrufer übergebene Datei oder Branch akzeptieren.
- GitHub App nur für `RonnsenDD/lhh-data-hub` installieren. Minimal erforderlich: Repository-Metadaten lesen (GitHub-Standard) und Actions lesen/schreiben, damit Workflow-Runs abgefragt und `workflow_dispatch` ausgelöst werden kann. Keine Contents-, Administration- oder Organisationsrechte, sofern die API-Prüfung sie nicht nachweislich verlangt.
- App-ID und Installation-ID als nicht geheime Konfiguration; Private Key ausschließlich als Cloudflare Worker Secret. Installationstoken kurzlebig nur zur Laufzeit erzeugen, nicht persistieren/loggen. GitHub-App/Schlüssel erst nach gesonderter Freigabe erstellen.
- Ein zentraler SQLite-backed Durable Object reserviert pro Workflow mit Lease, Idempotency-Key, letzter Dispatch-Zeit, Tageszähler, aktivem Run und Backoff. Geplante Anfangsregeln: maximal ein Nachstart je Workflow pro 30 Minuten, höchstens zwei pro Workflow/Tag; keine erneute Anforderung bei laufendem oder unklarem Job. Werte fachlich bestätigen, bevor Dispatch aktiviert wird.
- `DISPATCH_MODE` ist standardmäßig `observe`; kein öffentlicher Pfad kann den Modus aktivieren. Umschaltung erfordert Worker-Konfigurationsänderung und gesonderte Freigabe. Rollback: zurück auf observe-only, bestehende Cron-Ausführung beibehalten, keine Produzenten-Schedules ändern.
- Die fünf Workflows müssen auf `main` weiterhin `workflow_dispatch` unterstützen. Das ist vor einer Aktivierung je Datei neu zu prüfen.

## Abnahme vor Aktivierung

1. Cloudflare-Kontotarif = Free und aktuelle Workers/DO-Kontingente im Dashboard kontrollieren; Paid-Tarif nur nach Kostenfreigabe.
2. CPU-/Subrequest-Metriken des bestehenden Watchdogs während des 48-Stunden-Observe-Tests prüfen.
3. Coordinator zunächst mit Testfällen und Dispatch deaktiviert testen: gleichzeitige Aufrufe erzeugen höchstens eine Reservierung; abgelaufene Lease kann einmalig übernommen werden; DO-Ausfall führt zu keinem Dispatch.
4. Je Workflow testen: laufend, wartend, fehlgeschlagen, erfolgreich aber alter Quellzeitpunkt, API-403/429/5xx, Timeout nach Dispatch-Anforderung, tägliches Limit und Mitternachtsreset UTC.
5. Danach gesonderte Freigabe für GitHub App/Secret, DO-Binding/Namespace und einen eng begrenzten echten Dispatch-Test einholen.

## Offizielle technische Referenzen

- [Workers Fetch Request / Redirect policy](https://developers.cloudflare.com/workers/runtime-apis/request/)
- [Durable Objects Pricing and Free limits](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers metrics and analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)
- [GitHub workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
