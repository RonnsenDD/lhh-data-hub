#!/usr/bin/env python3
"""Verify deployed KONRAD3D manifest and GeoJSON match in the shared Pages site."""
from __future__ import annotations

import hashlib
import json
import os
import urllib.request
from urllib.parse import urljoin


def fetch(url: str, accept: str) -> tuple[bytes, str]:
    request = urllib.request.Request(url, headers={"Accept": accept, "Cache-Control": "no-cache"})
    with urllib.request.urlopen(request, timeout=20) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}: {url}")
        content_type = response.headers.get("Content-Type", "")
        return response.read(), content_type


def verify(page_url: str) -> dict:
    if not page_url.startswith("https://"):
        raise ValueError("Pages-URL muss HTTPS verwenden")
    manifest_url = urljoin(page_url.rstrip("/") + "/", "konrad3d/latest.json")
    manifest_bytes, manifest_type = fetch(manifest_url, "application/json")
    if "json" not in manifest_type.lower():
        raise RuntimeError(f"Unerwarteter Manifest-Content-Type: {manifest_type}")
    manifest = json.loads(manifest_bytes)
    if manifest.get("schemaVersion") != 1 or manifest.get("product") != "DWD KONRAD3D":
        raise RuntimeError("KONRAD3D-Manifest entspricht nicht Schema v1")
    if manifest.get("status") not in {"current", "stale", "unavailable"}:
        raise RuntimeError("Ungültiger veröffentlichter Quellenstatus")
    if manifest.get("cellsGeoJSON") != "cells.geojson":
        raise RuntimeError("Manifest verweist außerhalb des KONRAD3D-Verzeichnisses")
    geo_url = urljoin(page_url.rstrip("/") + "/", "konrad3d/cells.geojson")
    geo_bytes, geo_type = fetch(geo_url, "application/geo+json,application/json")
    if "json" not in geo_type.lower():
        raise RuntimeError(f"Unerwarteter GeoJSON-Content-Type: {geo_type}")
    if hashlib.sha256(geo_bytes).hexdigest() != manifest.get("cellsGeoJSONSha256"):
        raise RuntimeError("Öffentliche GeoJSON-Prüfsumme stimmt nicht mit dem Manifest überein")
    collection = json.loads(geo_bytes)
    if collection.get("type") != "FeatureCollection" or not isinstance(collection.get("features"), list):
        raise RuntimeError("Öffentliche Zellen-Datei ist keine GeoJSON-FeatureCollection")
    if manifest["status"] == "unavailable" and collection["features"]:
        raise RuntimeError("Unavailable darf keine historischen Zellfeatures ausliefern")
    result = {key: manifest.get(key) for key in ("status", "referenceTime", "creationTime", "retrievedAt", "totalCells", "relevantCellCount", "cellResult")}
    result["geoJsonFeatureCount"] = len(collection["features"])
    print(json.dumps(result, ensure_ascii=False))
    return result


if __name__ == "__main__":
    verify(os.environ["PAGE_URL"])
