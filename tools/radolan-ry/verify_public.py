#!/usr/bin/env python3
"""Read-only smoke test for the deployed GitHub Pages radar artifact."""
import hashlib
import json
import os
import time
import urllib.parse
import urllib.request


def fetch(url):
    request = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "lhh-data-hub-radar-smoke/1.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return response.read(), response.headers, response.status


def main():
    base = os.environ["PAGE_URL"].rstrip("/") + "/"
    latest = urllib.parse.urljoin(base, "radar/latest.json") + "?t=" + str(int(time.time()))
    body, headers, status = fetch(latest)
    if status != 200:
        raise SystemExit(f"latest.json HTTP {status}")
    data = json.loads(body)
    origin = headers.get("Access-Control-Allow-Origin", "")
    print(json.dumps({"http": status, "status": data.get("status"), "productTime": data.get("productTime"),
                      "frameId": data.get("frameId"), "accessControlAllowOrigin": origin}, ensure_ascii=False))
    if data.get("status") not in ("current", "stale"):
        raise SystemExit("Radar feed ist nicht aktuell verfügbar; latest.json zeigt den Fehlerstatus.")
    if not data.get("frameId") or data["frameId"] not in str(data.get("rainImage")) or data["frameId"] not in str(data.get("coverageImage")):
        raise SystemExit("Frame-ID und PNG-Referenzen stimmen nicht überein")
    for key, checksum in (("rainImage", "imageSha256"), ("coverageImage", "coverageSha256")):
        url = urllib.parse.urljoin(urllib.parse.urljoin(base, "radar/latest.json"), data[key])
        image, image_headers, image_status = fetch(url)
        if image_status != 200 or not image.startswith(bytes((137,80,78,71,13,10,26,10))):
            raise SystemExit(f"{key}: kein erfolgreiches PNG (HTTP {image_status})")
        if hashlib.sha256(image).hexdigest() != data.get(checksum):
            raise SystemExit(f"{key}: SHA256 stimmt nicht mit latest.json überein")
        print(f"{key}: HTTP {image_status}, {len(image)} Bytes, ACAO={image_headers.get('Access-Control-Allow-Origin', '(nicht gesetzt)')}")
    print("Öffentliche Frame- und Metadatenprüfung erfolgreich.")


if __name__ == "__main__":
    main()

