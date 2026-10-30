#!/usr/bin/env python3
"""Restore independently verified last-good snapshots from the public Pages site."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

DEFAULT_PAGE_URL = "https://ronnsendd.github.io/lhh-data-hub/"
PNG_SIGNATURE = bytes((137, 80, 78, 71, 13, 10, 26, 10))
MAX_JSON_BYTES = 1 * 1024 * 1024
MAX_PNG_BYTES = 10 * 1024 * 1024
MAX_GEOJSON_BYTES = 10 * 1024 * 1024
FETCH_TIMEOUT_SECONDS = 15
FetchResource = Callable[[str, str, int], bytes]


def _http_fetch(url: str, accept: str, limit: int) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": accept,
            "Cache-Control": "no-cache, no-store",
            "Pragma": "no-cache",
            "User-Agent": "lhh-data-hub-radar-retention/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
            if response.status != 200:
                raise ConnectionError(f"Pages HTTP {response.status}")
            content_type = response.headers.get("Content-Type", "").lower()
            if "json" not in content_type and "geo+" not in content_type and accept != "image/png":
                raise ValueError(f"unerwarteter Content-Type: {content_type or '(fehlt)'}")
            if accept == "image/png" and "image/png" not in content_type:
                raise ValueError(f"unerwarteter PNG-Content-Type: {content_type or '(fehlt)'}")
            data = response.read(limit + 1)
            if len(data) > limit:
                raise ValueError("Antwort überschreitet das Größenlimit")
            return data
    except urllib.error.HTTPError as error:
        if error.code == 404:
            raise FileNotFoundError("Pages-Ressource HTTP 404") from error
        raise ConnectionError(f"Pages HTTP {error.code}") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise ConnectionError(f"Pages-Abruf fehlgeschlagen: {type(error).__name__}") from error


def _cache_busted(base_url: str, relative_path: str) -> str:
    url = urllib.parse.urljoin(base_url.rstrip("/") + "/", relative_path)
    return url + ("&" if "?" in url else "?") + "restore=" + str(time.time_ns())


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".restore.tmp")
    try:
        temp.write_bytes(data)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def _parse_time(value: object) -> datetime:
    if not isinstance(value, str):
        raise ValueError("Produktzeit fehlt")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("Produktzeit besitzt keine Zeitzone")
    return parsed.astimezone(timezone.utc)


def _manifest(fetcher: FetchResource, base_url: str, path: str) -> tuple[dict, bytes]:
    raw = fetcher(_cache_busted(base_url, path), "application/json", MAX_JSON_BYTES)
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Manifest ist kein JSON-Objekt")
    return value, raw


def _sha256(raw: bytes, expected: object, label: str) -> None:
    if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise ValueError(f"{label}-Prüfsumme fehlt")
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError(f"{label}-Prüfsumme stimmt nicht")


def _radar(site_dir: Path, base_url: str, fetcher: FetchResource) -> str:
    manifest, manifest_bytes = _manifest(fetcher, base_url, "radar/latest.json")
    if manifest.get("schemaVersion") != 1 or manifest.get("product") != "RADOLAN-RY":
        raise ValueError("RADOLAN-Manifest entspricht nicht Schema v1")
    if manifest.get("status") not in ("current", "stale"):
        raise ValueError("RADOLAN-Manifest enthält keinen validierten Frame")
    frame_id = manifest.get("frameId")
    if not isinstance(frame_id, str) or not re.fullmatch(r"\d{8}T\d{6}Z", frame_id):
        raise ValueError("RADOLAN-Frame-ID ist ungültig")
    product_time = _parse_time(manifest.get("productTime"))
    if product_time.strftime("%Y%m%dT%H%M%SZ") != frame_id:
        raise ValueError("RADOLAN-Frame-ID und Produktzeit passen nicht zusammen")
    expected_paths = {
        "rainImage": f"frames/{frame_id}/rain.png",
        "coverageImage": f"frames/{frame_id}/coverage.png",
    }
    fetched: dict[str, bytes] = {}
    for key, checksum_key in (("rainImage", "imageSha256"), ("coverageImage", "coverageSha256")):
        if manifest.get(key) != expected_paths[key]:
            raise ValueError(f"RADOLAN-{key} verweist nicht auf denselben Frame")
        raw = fetcher(_cache_busted(base_url, f"radar/{expected_paths[key]}"), "image/png", MAX_PNG_BYTES)
        if not raw.startswith(PNG_SIGNATURE):
            raise ValueError(f"RADOLAN-{key} ist kein PNG")
        _sha256(raw, manifest.get(checksum_key), key)
        fetched[key] = raw

    radar_dir = site_dir / "radar"
    for key, raw in fetched.items():
        _atomic_write(radar_dir / expected_paths[key], raw)
    _atomic_write(radar_dir / "latest.json", manifest_bytes)
    return str(manifest["productTime"])


def _konrad(site_dir: Path, base_url: str, fetcher: FetchResource) -> str:
    manifest, manifest_bytes = _manifest(fetcher, base_url, "konrad3d/latest.json")
    if manifest.get("schemaVersion") != 1 or manifest.get("product") != "DWD KONRAD3D":
        raise ValueError("KONRAD3D-Manifest entspricht nicht Schema v1")
    if manifest.get("status") not in ("current", "stale"):
        raise ValueError("KONRAD3D-Manifest enthält keinen validierten Datensatz")
    _parse_time(manifest.get("referenceTime"))
    if manifest.get("cellsGeoJSON") != "cells.geojson":
        raise ValueError("KONRAD3D-GeoJSON-Pfad ist ungültig")
    geo = fetcher(_cache_busted(base_url, "konrad3d/cells.geojson"), "application/geo+json,application/json", MAX_GEOJSON_BYTES)
    _sha256(geo, manifest.get("cellsGeoJSONSha256"), "KONRAD3D-GeoJSON")
    collection = json.loads(geo.decode("utf-8"))
    if collection.get("type") != "FeatureCollection" or not isinstance(collection.get("features"), list):
        raise ValueError("KONRAD3D-Antwort ist keine gültige FeatureCollection")
    geo_time = collection.get("properties", {}).get("referenceTime")
    if geo_time and geo_time != manifest.get("referenceTime"):
        raise ValueError("KONRAD3D-Manifest und GeoJSON gehören zu verschiedenen Produktzeiten")
    konrad_dir = site_dir / "konrad3d"
    _atomic_write(konrad_dir / "cells.geojson", geo)
    _atomic_write(konrad_dir / "latest.json", manifest_bytes)
    return str(manifest["referenceTime"])


def restore_previous(
    site_dir: Path,
    page_url: str = DEFAULT_PAGE_URL,
    fetcher: FetchResource = _http_fetch,
) -> dict[str, dict[str, str]]:
    """Restore each product independently; a missing/invalid snapshot is non-fatal."""
    base = page_url.rstrip("/") + "/"
    outcomes: dict[str, dict[str, str]] = {}
    for product, restore in (("radar", _radar), ("konrad3d", _konrad)):
        try:
            value = restore(Path(site_dir), base, fetcher)
            outcomes[product] = {"result": "restored", "productTime": value}
        except FileNotFoundError as error:
            outcomes[product] = {"result": "missing", "reason": " ".join(str(error).split())[:240]}
        except (ConnectionError, urllib.error.URLError, TimeoutError) as error:
            outcomes[product] = {"result": "error", "reason": " ".join(str(error).split())[:240]}
        except Exception as error:
            outcomes[product] = {"result": "invalid", "reason": " ".join(str(error).split())[:240]}
    return outcomes


def deployment_blockers(
    restore_report: dict[str, dict[str, str]],
    producer_outcomes: dict[str, str],
) -> list[str]:
    """Block a shared Pages deploy only when a failed producer has no verifiable fallback."""
    blockers = []
    for product in ("radar", "konrad3d"):
        restored = restore_report.get(product, {}).get("result")
        producer = producer_outcomes.get(product)
        if restored == "error" and producer != "success":
            blockers.append(product)
    return blockers


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-dir", type=Path)
    parser.add_argument("--page-url", default=os.environ.get("RADAR_PUBLIC_PAGES_URL", DEFAULT_PAGE_URL))
    parser.add_argument("--report-file", type=Path)
    parser.add_argument("--check-publish", action="store_true")
    parser.add_argument("--radar-outcome", choices=("success", "failure", "cancelled"))
    parser.add_argument("--konrad-outcome", choices=("success", "failure", "cancelled"))
    args = parser.parse_args()
    if args.check_publish:
        if not args.report_file or not args.report_file.is_file():
            parser.error("--check-publish benötigt ein vorhandenes --report-file")
        if not args.radar_outcome or not args.konrad_outcome:
            parser.error("--check-publish benötigt beide Producer-Ergebnisse")
        report = json.loads(args.report_file.read_text(encoding="utf-8"))
        blockers = deployment_blockers(
            report,
            {"radar": args.radar_outcome, "konrad3d": args.konrad_outcome},
        )
        if blockers:
            print("Pages-Deployment abgebrochen: nicht erreichbarer letzter Stand und fehlgeschlagener Produzent für " + ", ".join(blockers))
            return 1
        print("Pages-Deployment sicher: jeder fehlgeschlagene Produzent hat einen verifizierten Snapshot oder eine erfolgreiche Ersatzverarbeitung.")
        return 0
    if not args.site_dir:
        parser.error("Regulärer Restore benötigt --site-dir")
    outcomes = restore_previous(args.site_dir, args.page_url)
    report = json.dumps(outcomes, ensure_ascii=False, indent=2) + "\n"
    if args.report_file:
        _atomic_write(args.report_file, report.encode("utf-8"))
    print(report, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
