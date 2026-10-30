# RADOLAN-RY und KONRAD3D: Betrieb und Fehlerzustände

## Daten- und Veröffentlichungsmodell

Der einzige GitHub-Pages-Veröffentlicher für die beiden Radarprodukte ist
.github/workflows/update-radolan-ry.yml. Er baut beide Produkte in einem
Pages-Artefakt, hält die Produktpfade aber getrennt:

- radar/latest.json plus exakt ein referenzierter Frame mit rain.png und coverage.png
- konrad3d/latest.json plus cells.geojson

Beide Manifeste halten Produktzeit, Abrufversuch und Veröffentlichung getrennt.
status ist eine Momentaufnahme beim Erstellen des Manifests. Verbraucher müssen
das Datenalter weiter selbst aus productTime (RADOLAN) beziehungsweise
referenceTime (KONRAD3D) bestimmen. DesignTest macht dies unabhängig vom
gespeicherten Status: RADOLAN wird nach 15 Minuten als veraltet angezeigt; die
KONRAD3D-Zellgeometrien werden bei veralteten Daten ausgeblendet.

## Verhalten bei einem fehlgeschlagenen Abruf

Vor den Produzenten versucht tools/radolan-ry/restore_previous.py die bisherige
öffentliche Pages-Version für jedes Produkt unabhängig abzurufen. Die
Wiederherstellung ist nicht fatal, nutzt keine Tokens und akzeptiert nur:

- erwartetes Produkt und Schema,
- zusammengehörige Produktzeit und Frame-ID,
- die erwarteten Pfade,
- gültige PNG-/GeoJSON-Struktur und passende SHA-256-Prüfsummen.

Kann nur ein Produkt wiederhergestellt werden, bleibt das andere davon
unabhängig. Die nächste erfolgreiche Verarbeitung ersetzt den alten Datensatz
und entfernt ältere Radarframes.

Bei einem RADOLAN-Fehler bleibt ein checksum-validierter letzter Frame im
Artefakt. productTime und retrievedAt bleiben unverändert; lastAttemptAt,
publishedAt, fetchStatus: error und error beschreiben den neuen Fehler.
Der Status wird mit dem unveränderten Produktzeitpunkt erneut bewertet. Ohne
gültigen Vorframe wird unavailable ohne Bildverweis veröffentlicht. Ein
älterer DWD-Frame darf keinen bereits veröffentlichten neueren Frame ersetzen.

KONRAD3D erhält denselben unabhängigen Rückfall: Ein fehlerhafter Abruf oder
Parserlauf ersetzt ein checksum-validiertes GeoJSON nicht durch eine leere
Zellliste. Das Fehler-Manifest erhält den ursprünglichen referenceTime, den
unveränderten GeoJSON-Hash und fetchStatus: error; veraltete Zellen werden im
Dashboard weiterhin nicht als aktuelle Gewitterzellen gezeichnet. Ohne gültigen
Vorwert werden ein unavailable-Manifest und ein leeres GeoJSON ausgegeben.

## Zeitplan und Überwachung

Der Workflow ist auf dem Default-Branch main aktiv und verwendet
7,22,37,52 * * * * (UTC), workflow_dispatch, Standard-Runner und eine
einzige Concurrency-Gruppe für die Pages-Veröffentlichung. Der Schedule-Audit
ist ein separater Job. Ein erfolgreicher publish-Job bleibt damit von einem
fehlgeschlagenen Schedule-Audit unterscheidbar.

GitHub dokumentiert, dass geplante Ereignisse bei hoher Auslastung verzögert
oder ausgelassen werden können. Der aktuelle Cron liegt bereits abseits des
Stundenbeginns. Da der Workflow aktiv ist, echte schedule-Ereignisse erzeugt
und keine nennenswerte Runner-Wartezeit aufweisen, wäre eine bloße Verschiebung
der Minuten kein belegter Fehlerfix. Der Zeitplan bleibt deshalb Best Effort;
es wird keine garantierte 15-Minuten-Ausführung behauptet.
Weitere Informationen:
https://docs.github.com/en/actions/how-tos/troubleshoot-workflows#scheduled-workflows-running-at-unexpected-times

## Prüfstand 30.10.2026

- Workflow-State laut GitHub API: active; Default-Branch: main.
- Erwartete Frequenz: alle 15 Minuten; letzter Lauf zum Prüfzeitpunkt war
  schedule Run #13, gestartet 06:21:40 UTC. Der vorherige Schedule-Lauf
  startete 00:28:04 UTC; Abstand 353,6 Minuten.
- Run #13 veröffentlichte erfolgreich: beide DWD-Produzenten, Pages-Upload,
  Pages-Deployment und beide öffentlichen Verifikationen waren erfolgreich.
  Nur Schedule health schlug fehl.
- Öffentlicher Snapshot von 06:21 UTC: RADOLAN-Produktzeit 06:20 UTC;
  KONRAD3D-Referenzzeit 06:15 UTC. Am 08:09 UTC lieferte ein lokaler
  End-to-End-Test aus der DWD-Quelle bereits RADOLAN 08:05 UTC und KONRAD3D
  08:00 UTC. Beide Produzenten wählten und verarbeiteten diese Zeitstände als
  aktuell. Das belegt eine Schedule-Lücke, nicht einen DWD-Ausfall.
- Auch die Wetter- und Pegelworkflows im selben öffentlichen Repository zeigten
  mehrstündige Abstände; die verfügbaren Läufe hatten keine nennenswerte
  Start-Wartezeit. Das weist auf die Best-Effort-Grenze des zentralen
  GitHub-Schedulers hin, beweist aber keine interne GitHub-Ursache.
