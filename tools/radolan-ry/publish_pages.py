#!/usr/bin/env python3
"""Render the existing RADOLAN decoder output into a replaceable static artifact."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import radolan_ry as decoder

PNG_SIGNATURE = bytes((137, 80, 78, 71, 13, 10, 26, 10))


def publish(site_dir: Path, metadata: dict[str, Any], raster_dir: Path) -> dict[str, Any]:
    product_time = metadata["productTime"]
    product_dt = decoder.parse_utc(product_time)
    frame_id = product_dt.strftime("%Y%m%dT%H%M%SZ")
    radar_dir = site_dir / "radar"
    frames_dir = radar_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    for old in frames_dir.iterdir():
        if old.is_dir() and old.name != frame_id:
            shutil.rmtree(old)
        elif old.is_file():
            old.unlink()
    frame_dir = frames_dir / frame_id
    frame_dir.mkdir(parents=True, exist_ok=True)
    rain = raster_dir / metadata["image"]
    coverage = raster_dir / metadata["coverageMask"]
    for path in (rain, coverage):
        if not path.is_file() or path.stat().st_size == 0 or path.read_bytes()[:8] != PNG_SIGNATURE:
            raise ValueError("Decoder-Ausgabe fehlt oder ist kein gültiges PNG")
    rain_out, coverage_out = frame_dir / "rain.png", frame_dir / "coverage.png"
    shutil.copyfile(rain, rain_out)
    shutil.copyfile(coverage, coverage_out)
    published = datetime.now(timezone.utc)
    age = (published - product_dt).total_seconds() / 60
    status = "unavailable" if age < -1 else "stale" if age > decoder.MAX_AGE_MINUTES else "current"
    west, south, east, north = decoder.OUTPUT_BOUNDS
    result = {
        "schemaVersion": 1,
        "product": "RADOLAN-RY",
        "quantity": "RATE",
        "unit": "mm/h",
        "status": status,
        "error": "Produktzeitpunkt liegt in der Zukunft." if status == "unavailable" else None,
        "frameId": frame_id,
        "productStart": metadata["productStart"],
        "productTime": product_time,
        "retrievedAt": metadata["retrievedAt"],
        "publishedAt": decoder.iso_utc(published),
        "ageMinutes": round(age, 2),
        "staleAfterMinutes": decoder.MAX_AGE_MINUTES,
        "bounds": {"west": west, "south": south, "east": east, "north": north},
        "crs": metadata["crs"],
        "width": metadata["width"],
        "height": metadata["height"],
        "resolutionM": metadata["resolutionM"],
        "imageCoordinates": metadata["imageCoordinates"],
        "rainImage": f"frames/{frame_id}/rain.png" if status != "unavailable" else None,
        "coverageImage": f"frames/{frame_id}/coverage.png" if status != "unavailable" else None,
        "imageSha256": hashlib.sha256(rain_out.read_bytes()).hexdigest(),
        "coverageSha256": hashlib.sha256(coverage_out.read_bytes()).hexdigest(),
        "imageBytes": rain_out.stat().st_size,
        "coverageBytes": coverage_out.stat().st_size,
        "coverage": metadata["coverage"],
        "source": decoder.SOURCE,
        "sourceUrl": decoder.SOURCE_URL,
        "attribution": "Datenbasis: Deutscher Wetterdienst (DWD), RADOLAN-RY; eigene Rasterdarstellung.",
        "interpretation": metadata["interpretation"],
    }
    if status == "unavailable":
        shutil.rmtree(frame_dir)
    decoder.atomic_json(radar_dir / "latest.json", result)
    return result


def unavailable(site_dir: Path, error: Exception, attempt: datetime) -> dict[str, Any]:
    frames_dir = site_dir / "radar" / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    for old in frames_dir.iterdir():
        if old.is_dir():
            shutil.rmtree(old)
        else:
            old.unlink()
    try:
        previous = json.loads((site_dir / "radar" / "latest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        previous = {}
    result = {
        "schemaVersion": 1,
        "product": "RADOLAN-RY",
        "status": "unavailable",
        "error": " ".join(f"{type(error).__name__}: {error}".split())[:400],
        "frameId": None,
        "productTime": None,
        "retrievedAt": None,
        "publishedAt": decoder.iso_utc(attempt),
        "lastAttemptAt": decoder.iso_utc(attempt),
        "lastValidProductTime": previous.get("productTime") or previous.get("lastValidProductTime"),
        "staleAfterMinutes": decoder.MAX_AGE_MINUTES,
        "bounds": dict(zip(("west", "south", "east", "north"), decoder.OUTPUT_BOUNDS)),
        "rainImage": None,
        "coverageImage": None,
        "source": decoder.SOURCE,
        "sourceUrl": decoder.SOURCE_URL,
        "attribution": "Datenbasis: Deutscher Wetterdienst (DWD), RADOLAN-RY; eigene Rasterdarstellung.",
        "interpretation": "Quelle oder Dekodierung nicht verfügbar; kein aktueller Radarframe wird dargestellt.",
    }
    decoder.atomic_json(site_dir / "radar" / "latest.json", result)
    return result


def run(site_dir: Path, download_dir: Path) -> dict[str, Any]:
    attempt = datetime.now(timezone.utc)
    try:
        source, _, _ = decoder.download_latest(download_dir, attempt)
        grid = decoder.read_product(source, attempt)
        with tempfile.TemporaryDirectory(prefix="radolan-render-") as tmp:
            meta = decoder.decode_to_maplibre(grid, Path(tmp))
            return publish(site_dir, meta, Path(tmp))
    except Exception as exc:
        unavailable(site_dir, exc, attempt)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-dir", type=Path, required=True)
    parser.add_argument("--download-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = run(args.site_dir, args.download_dir)
    except Exception as exc:
        print(json.dumps({"status": "unavailable", "error": " ".join(f"{type(exc).__name__}: {exc}".split())[:400]}))
        return 1
    print(json.dumps({key: result.get(key) for key in ("status", "frameId", "productTime", "retrievedAt", "publishedAt", "ageMinutes", "imageBytes", "coverageBytes")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

