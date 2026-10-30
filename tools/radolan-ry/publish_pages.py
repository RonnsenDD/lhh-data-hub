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
INDEX_HTML = """<!doctype html>
<html lang="de">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DWD RADOLAN-RY – Lauchhammer</title>
<main>
  <h1>DWD RADOLAN-RY – Lauchhammer</h1>
  <p>Maschinenlesbarer Status: <a href="radar/latest.json">radar/latest.json</a></p>
</main>
</html>
"""


def ensure_pages_entry(site_dir: Path) -> None:
    site_dir.mkdir(parents=True, exist_ok=True)
    (site_dir / "index.html").write_text(INDEX_HTML, encoding="utf-8")


def _previous_manifest(radar_dir: Path) -> dict[str, Any]:
    try:
        value = json.loads((radar_dir / "latest.json").read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _valid_previous_frame(radar_dir: Path, previous: dict[str, Any]) -> tuple[str, Path, Path] | None:
    if previous.get("product") != "RADOLAN-RY" or previous.get("status") not in ("current", "stale"):
        return None
    frame_id = previous.get("frameId")
    try:
        product_dt = decoder.parse_utc(previous.get("productTime"))
    except (TypeError, ValueError):
        return None
    if product_dt.strftime("%Y%m%dT%H%M%SZ") != frame_id:
        return None
    expected = {
        "rainImage": f"frames/{frame_id}/rain.png",
        "coverageImage": f"frames/{frame_id}/coverage.png",
    }
    paths = tuple(radar_dir / expected[key] for key in ("rainImage", "coverageImage"))
    hashes = (previous.get("imageSha256"), previous.get("coverageSha256"))
    for path, expected_hash in zip(paths, hashes):
        if not path.is_file() or path.stat().st_size <= 0 or path.stat().st_size > 10 * 1024 * 1024:
            return None
        raw = path.read_bytes()
        if not raw.startswith(PNG_SIGNATURE) or hashlib.sha256(raw).hexdigest() != expected_hash:
            return None
    if previous.get("rainImage") != expected["rainImage"] or previous.get("coverageImage") != expected["coverageImage"]:
        return None
    return frame_id, paths[0], paths[1]


def _prune_frames(frames_dir: Path, keep_frame_id: str | None) -> None:
    if not frames_dir.exists():
        return
    for old in frames_dir.iterdir():
        if old.name == keep_frame_id:
            continue
        if old.is_dir():
            shutil.rmtree(old)
        else:
            old.unlink()


def unavailable(site_dir: Path, error: Exception, attempt: datetime) -> dict[str, Any]:
    """Publish a failed refresh without discarding a checksum-verified last-good frame."""
    ensure_pages_entry(site_dir)
    radar_dir = site_dir / "radar"
    frames_dir = radar_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    previous = _previous_manifest(radar_dir)
    valid_frame = _valid_previous_frame(radar_dir, previous)
    safe_error = " ".join(f"{type(error).__name__}: {error}".split())[:400]
    attempted_at = attempt.astimezone(timezone.utc)

    if valid_frame:
        frame_id, rain_path, coverage_path = valid_frame
        product_time = previous["productTime"]
        product_dt = decoder.parse_utc(product_time)
        age = (attempted_at - product_dt).total_seconds() / 60
        status = "unavailable" if age < -1 else "stale" if age > decoder.MAX_AGE_MINUTES else "current"
        if status != "unavailable":
            result = dict(previous)
            result.update({
                "status": status,
                "error": safe_error,
                "fetchStatus": "error",
                "fetchStatusReason": "Letzter Abruf oder Verarbeitung fehlgeschlagen; Frame bleibt checksum-validiert erhalten. Datenalter wird weiterhin aus productTime berechnet.",
                "frameId": frame_id,
                "productTime": product_time,
                "retrievedAt": previous.get("retrievedAt"),
                "publishedAt": decoder.iso_utc(attempted_at),
                "lastAttemptAt": decoder.iso_utc(attempted_at),
                "lastValidProductTime": previous.get("lastValidProductTime") or product_time,
                "ageMinutes": round(max(0.0, age), 2),
                "staleAfterMinutes": decoder.MAX_AGE_MINUTES,
                "rainImage": f"frames/{frame_id}/rain.png",
                "coverageImage": f"frames/{frame_id}/coverage.png",
            })
            decoder.atomic_json(radar_dir / "latest.json", result)
            _prune_frames(frames_dir, frame_id)
            return result
        valid_frame = None

    _prune_frames(frames_dir, None)
    result = {
        "schemaVersion": 1,
        "product": "RADOLAN-RY",
        "status": "unavailable",
        "error": safe_error,
        "fetchStatus": "error",
        "fetchStatusReason": "Kein checksum-validierter letzter Frame verfügbar.",
        "frameId": None,
        "productTime": None,
        "retrievedAt": None,
        "publishedAt": decoder.iso_utc(attempted_at),
        "lastAttemptAt": decoder.iso_utc(attempted_at),
        "lastValidProductTime": previous.get("productTime") or previous.get("lastValidProductTime"),
        "staleAfterMinutes": decoder.MAX_AGE_MINUTES,
        "bounds": dict(zip(("west", "south", "east", "north"), decoder.OUTPUT_BOUNDS)),
        "rainImage": None,
        "coverageImage": None,
        "source": decoder.SOURCE,
        "sourceUrl": decoder.SOURCE_URL,
        "attribution": "Datenbasis: Deutscher Wetterdienst (DWD), RADOLAN-RY; eigene Rasterdarstellung.",
        "interpretation": "Quelle oder Dekodierung nicht verfügbar; kein validierter Radarframe ist verfügbar.",
    }
    decoder.atomic_json(radar_dir / "latest.json", result)
    return result


def publish(site_dir: Path, metadata: dict[str, Any], raster_dir: Path) -> dict[str, Any]:
    """Stage a complete product frame before replacing the manifest or old frame."""
    ensure_pages_entry(site_dir)
    product_time = metadata["productTime"]
    product_dt = decoder.parse_utc(product_time)
    frame_id = product_dt.strftime("%Y%m%dT%H%M%SZ")
    radar_dir = site_dir / "radar"
    frames_dir = radar_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    previous = _previous_manifest(radar_dir)
    previous_time_value = previous.get("productTime") or previous.get("lastValidProductTime")
    if previous_time_value:
        try:
            previous_time = decoder.parse_utc(previous_time_value)
        except (TypeError, ValueError):
            previous_time = None
        if previous_time and product_dt < previous_time:
            raise ValueError("Ausgewähltes RADOLAN-Produkt ist älter als der letzte veröffentlichte gültige Frame")

    rain = raster_dir / metadata["image"]
    coverage = raster_dir / metadata["coverageMask"]
    for path in (rain, coverage):
        if not path.is_file() or path.stat().st_size == 0 or path.stat().st_size > 10 * 1024 * 1024 or path.read_bytes()[:8] != PNG_SIGNATURE:
            raise ValueError("Decoder-Ausgabe fehlt oder ist kein gültiges PNG")

    published = datetime.now(timezone.utc)
    age = (published - product_dt).total_seconds() / 60
    status = "unavailable" if age < -1 else "stale" if age > decoder.MAX_AGE_MINUTES else "current"
    if status == "unavailable":
        raise ValueError("Produktzeitpunkt liegt mehr als eine Minute in der Zukunft.")

    west, south, east, north = decoder.OUTPUT_BOUNDS
    stage_dir = Path(tempfile.mkdtemp(prefix=".radolan-staged-", dir=frames_dir))
    frame_dir = frames_dir / frame_id
    backup_container: Path | None = None
    backup_frame: Path | None = None
    try:
        rain_stage, coverage_stage = stage_dir / "rain.png", stage_dir / "coverage.png"
        shutil.copyfile(rain, rain_stage)
        shutil.copyfile(coverage, coverage_stage)
        rain_bytes, coverage_bytes = rain_stage.read_bytes(), coverage_stage.read_bytes()
        result = {
            "schemaVersion": 1,
            "product": "RADOLAN-RY",
            "quantity": "RATE",
            "unit": "mm/h",
            "status": status,
            "error": None,
            "fetchStatus": "success",
            "fetchStatusReason": "DWD-Produkt erfolgreich abgerufen und validiert.",
            "frameId": frame_id,
            "productStart": metadata["productStart"],
            "productTime": product_time,
            "retrievedAt": metadata["retrievedAt"],
            "publishedAt": decoder.iso_utc(published),
            "lastAttemptAt": metadata.get("retrievedAt") or decoder.iso_utc(published),
            "lastValidProductTime": product_time,
            "ageMinutes": round(age, 2),
            "staleAfterMinutes": decoder.MAX_AGE_MINUTES,
            "bounds": {"west": west, "south": south, "east": east, "north": north},
            "crs": metadata["crs"],
            "width": metadata["width"],
            "height": metadata["height"],
            "resolutionM": metadata["resolutionM"],
            "imageCoordinates": metadata["imageCoordinates"],
            "rainImage": f"frames/{frame_id}/rain.png",
            "coverageImage": f"frames/{frame_id}/coverage.png",
            "imageSha256": hashlib.sha256(rain_bytes).hexdigest(),
            "coverageSha256": hashlib.sha256(coverage_bytes).hexdigest(),
            "imageBytes": len(rain_bytes),
            "coverageBytes": len(coverage_bytes),
            "coverage": metadata["coverage"],
            "source": decoder.SOURCE,
            "sourceUrl": decoder.SOURCE_URL,
            "attribution": "Datenbasis: Deutscher Wetterdienst (DWD), RADOLAN-RY; eigene Rasterdarstellung.",
            "interpretation": metadata["interpretation"],
        }
        backup_container = Path(tempfile.mkdtemp(prefix=".radolan-backup-", dir=frames_dir))
        backup_frame = backup_container / frame_id
        if frame_dir.exists():
            frame_dir.rename(backup_frame)
        try:
            stage_dir.rename(frame_dir)
            decoder.atomic_json(radar_dir / "latest.json", result)
        except Exception:
            if frame_dir.exists():
                shutil.rmtree(frame_dir)
            if backup_frame.exists():
                backup_frame.rename(frame_dir)
            raise
        shutil.rmtree(backup_container, ignore_errors=True)
        backup_container = None
        _prune_frames(frames_dir, frame_id)
        return result
    finally:
        if stage_dir.exists():
            shutil.rmtree(stage_dir, ignore_errors=True)
        if backup_container and backup_container.exists():
            shutil.rmtree(backup_container, ignore_errors=True)

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

