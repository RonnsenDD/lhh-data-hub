#!/usr/bin/env python3
"""Decode a DWD RADOLAN-RY HDF5 file into a local MapLibre raster prototype.

This is a local prototype, not a hosted service. It never changes the SPFx
dashboard or uploads data. RY pixels are rates in 0.01 mm/h units; HDF5
no-data pixels are rendered in a separate hatched coverage overlay.
"""
from __future__ import annotations

import argparse
import hashlib
import html.parser
import json
import math
import os
import re
import tempfile
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import h5py
import numpy as np
from PIL import Image
from pyproj import CRS, Transformer

DWD_DIRECTORY = "https://opendata.dwd.de/weather/radar/radolan/ry/"
PRODUCT_PATTERN = re.compile(r"^raa01-ry_10000-(\d{10})-dwd---bin\.hdf5$")
MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024
MAX_DIRECTORY_BYTES = 4 * 1024 * 1024
MAX_RASTER_CELLS = 2_000_000
MAX_OUTPUT_PIXELS = 1_000_000
MAX_AGE_MINUTES = 15
OUTPUT_BOUNDS = (13.35, 51.25, 14.20, 51.75)  # Lauchhammer and nearby towns
OUTPUT_RESOLUTION_M = 500
USER_AGENT = "Lauchhammer-DesignTest-RADOLAN-RY-prototype/1.0"
SOURCE = "Deutscher Wetterdienst (DWD), RADOLAN-RY"
SOURCE_URL = "https://opendata.dwd.de/weather/radar/radolan/ry/"


def parse_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Zeitstempel benötigt eine Zeitzone")
    return parsed.astimezone(timezone.utc)


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class ProductLinks(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.names: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "a":
            return
        href = dict(attrs).get("href")
        if isinstance(href, str) and PRODUCT_PATTERN.fullmatch(href):
            self.names.add(href)


def product_time_from_name(name: str) -> datetime:
    match = PRODUCT_PATTERN.fullmatch(Path(name).name)
    if not match:
        raise ValueError("Ungültiger RADOLAN-RY-Dateiname")
    return datetime.strptime(match.group(1), "%y%m%d%H%M").replace(tzinfo=timezone.utc)


def _fetch(url: str, limit: int, timeout: int = 20) -> tuple[bytes, str, str]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html, application/x-hdf5, application/octet-stream, */*"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        final_host = (urllib.parse.urlparse(response.geturl()).hostname or "").lower()
        if final_host != "opendata.dwd.de":
            raise ValueError(f"DWD-Weiterleitung zu nicht erlaubtem Host abgewiesen: {final_host or 'unbekannt'}")
        if response.status != 200:
            raise RuntimeError(f"DWD HTTP {response.status}")
        body = response.read(limit + 1)
        if len(body) > limit:
            raise ValueError("DWD-Antwort überschreitet das Größenlimit")
        return body, response.headers.get("Content-Type", ""), response.geturl()


def find_latest_product(now: datetime | None = None) -> tuple[str, datetime]:
    body, content_type, _ = _fetch(DWD_DIRECTORY, MAX_DIRECTORY_BYTES)
    if "html" not in content_type.lower() and b"<a" not in body[:4096].lower():
        raise ValueError("DWD-Verzeichnisantwort ist kein HTML-Index")
    parser = ProductLinks()
    parser.feed(body.decode("utf-8", errors="replace"))
    products = [(name, product_time_from_name(name)) for name in parser.names]
    cutoff = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    products = [(name, timestamp) for name, timestamp in products if timestamp <= cutoff]
    if not products:
        raise ValueError("Kein RY-Produkt mit Produktzeitpunkt bis zum Abrufzeitpunkt gefunden")
    return max(products, key=lambda item: item[1])


def _decode_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("ascii", errors="strict")
    return str(value)


@dataclass(frozen=True)
class RadolanGrid:
    values: np.ndarray
    product_start: datetime
    product_end: datetime
    retrieved_at: datetime
    gain: float
    offset: float
    nodata: int
    undetect: int
    projdef: str
    xscale: float
    yscale: float
    xsize: int
    ysize: int
    source_size: int
    sha256: str


def read_product(path: Path, retrieved_at: datetime | None = None) -> RadolanGrid:
    path = Path(path)
    named_time = product_time_from_name(path.name)
    file_size = path.stat().st_size
    if file_size <= 0 or file_size > MAX_DOWNLOAD_BYTES:
        raise ValueError("RADOLAN-RY-Dateigröße außerhalb des erlaubten Bereichs")
    with h5py.File(path, "r") as source:
        try:
            data_set = source["dataset1/data1/data"]
            what = source["dataset1/what"].attrs
            data_what = source["dataset1/data1/what"].attrs
            where = source["where"].attrs
        except KeyError as exc:
            raise ValueError(f"Erwartete ODIM-HDF5-Eigenschaft fehlt: {exc}") from exc
        if _decode_text(what["prodname"]) != "RY" or _decode_text(data_what["quantity"]) != "RATE":
            raise ValueError("HDF5-Datei ist kein RADOLAN-RY-Ratenprodukt")
        expected_shape = (int(where["ysize"]), int(where["xsize"]))
        ysize, xsize = expected_shape
        if (ysize <= 0 or xsize <= 0 or ysize * xsize > MAX_RASTER_CELLS or
                data_set.shape != expected_shape or data_set.ndim != 2 or
                not np.issubdtype(data_set.dtype, np.integer)):
            raise ValueError("RADOLAN-RY-Rasterdimension oder Datentyp ist ungültig")
        gain, offset = float(data_what["gain"]), float(data_what["offset"])
        nodata, undetect = int(data_what["nodata"]), int(data_what["undetect"])
        xscale, yscale = float(where["xscale"]), float(where["yscale"])
        if not (math.isfinite(gain) and gain > 0 and math.isfinite(offset) and xscale > 0 and yscale > 0):
            raise ValueError("RADOLAN-RY-Skalierungsattribute ungültig")
        if not math.isclose(xscale, 1000, abs_tol=0.01) or not math.isclose(yscale, 1000, abs_tol=0.01):
            raise ValueError("Unerwartete RADOLAN-RY-Rasterweite")
        projdef = _decode_text(where["projdef"])
        if not all(value in projdef for value in ("+proj=stere", "+lat_ts=60", "+lon_0=10")):
            raise ValueError("Unerwartete RADOLAN-Projektion")
        start = datetime.strptime(_decode_text(what["startdate"]) + _decode_text(what["starttime"]), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
        end = datetime.strptime(_decode_text(what["enddate"]) + _decode_text(what["endtime"]), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
        if end != named_time or start >= end or (end - start).total_seconds() != 300:
            raise ValueError("HDF5-Produktzeit und Dateiname stimmen nicht mit dem 5-Minuten-RY-Intervall überein")
        # The DWD HDF5 projection metadata defines a 1-km grid whose outer
        # northwest edge is (-500 m, +500 m); confirm it against all four
        # geographic corner attributes before trusting array indices.
        grid_crs = CRS.from_proj4(projdef)
        forward = Transformer.from_crs("EPSG:4326", grid_crs, always_xy=True)
        corner_checks = (
            ("UL", float(where["UL_lon"]), float(where["UL_lat"]), (-500, 500)),
            ("UR", float(where["UR_lon"]), float(where["UR_lat"]), (int(where["xsize"]) * 1000 - 500, 500)),
            ("LL", float(where["LL_lon"]), float(where["LL_lat"]), (-500, 500 - int(where["ysize"]) * 1000)),
            ("LR", float(where["LR_lon"]), float(where["LR_lat"]), (int(where["xsize"]) * 1000 - 500, 500 - int(where["ysize"]) * 1000)),
        )
        for corner_name, lon, lat, expected in corner_checks:
            actual = forward.transform(lon, lat)
            if math.hypot(actual[0] - expected[0], actual[1] - expected[1]) > 5:
                raise ValueError(f"DWD-{corner_name}-Eckkoordinate weicht von HDF5-Rastergeometrie ab")
        values = np.asarray(data_set[:])
    return RadolanGrid(values, start, end, (retrieved_at or datetime.now(timezone.utc)).astimezone(timezone.utc),
                       gain, offset, nodata, undetect, projdef, xscale, yscale,
                       xsize, ysize, file_size,
                       hashlib.sha256(path.read_bytes()).hexdigest())


def geographic_crop(bounds: tuple[float, float, float, float], resolution_m: int = OUTPUT_RESOLUTION_M) -> dict[str, Any]:
    west, south, east, north = bounds
    if not (-180 <= west < east <= 180 and -90 < south < north < 90):
        raise ValueError("Ungültige geographische Ausdehnung")
    if not isinstance(resolution_m, int) or not 100 <= resolution_m <= 5000:
        raise ValueError("Rasterauflösung muss zwischen 100 und 5000 Metern liegen")
    to_mercator = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    to_geographic = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
    min_x, min_y = to_mercator.transform(west, south)
    max_x, max_y = to_mercator.transform(east, north)
    width = math.ceil((max_x - min_x) / resolution_m)
    height = math.ceil((max_y - min_y) / resolution_m)
    if width <= 0 or height <= 0 or width * height > MAX_OUTPUT_PIXELS:
        raise ValueError("Radar-Ausschnitt überschreitet das Pixelgrößenlimit")
    max_x = min_x + width * resolution_m
    min_y = max_y - height * resolution_m
    left, top = to_geographic.transform(min_x, max_y)
    right, bottom = to_geographic.transform(max_x, min_y)
    return {"width": width, "height": height, "resolutionM": resolution_m,
            "bbox3857": [min_x, min_y, max_x, max_y],
            "imageCoordinates": [[left, top], [right, top], [right, bottom], [left, bottom]]}


def source_indices(grid: RadolanGrid, crop: dict[str, Any]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    min_x, min_y, max_x, max_y = crop["bbox3857"]
    width, height, res = crop["width"], crop["height"], crop["resolutionM"]
    xs = min_x + (np.arange(width, dtype=np.float64) + 0.5) * res
    ys = max_y - (np.arange(height, dtype=np.float64) + 0.5) * res
    xx, yy = np.meshgrid(xs, ys)
    to_geo = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
    to_source = Transformer.from_crs("EPSG:4326", CRS.from_proj4(grid.projdef), always_xy=True)
    lon, lat = to_geo.transform(xx, yy)
    sx, sy = to_source.transform(lon, lat)
    # HDF5 UL/UR/LL/LR coordinates are outer pixel corners; the first
    # source pixel center is therefore (0, 0) in the declared projection.
    cols = np.floor(np.asarray(sx) / grid.xscale).astype(np.int64)
    rows = np.floor(-np.asarray(sy) / grid.yscale).astype(np.int64)
    valid = (rows >= 0) & (rows < grid.ysize) & (cols >= 0) & (cols < grid.xsize)
    return rows, cols, valid


def geo_to_source_index(grid: RadolanGrid, longitude: float, latitude: float) -> tuple[int, int]:
    """Return source (row, column) for a WGS84 location using DWD projdef."""
    if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
        raise ValueError("Ungültige geographische Koordinate")
    to_source = Transformer.from_crs("EPSG:4326", CRS.from_proj4(grid.projdef), always_xy=True)
    x, y = to_source.transform(longitude, latitude)
    return math.floor(-y / grid.yscale), math.floor(x / grid.xscale)


def colorize(values: np.ndarray, nodata: int, undetect: int, gain: float, offset: float) -> tuple[Image.Image, Image.Image, dict[str, int]]:
    values = np.asarray(values)
    if values.ndim != 2 or values.dtype.kind not in "iu":
        raise ValueError("Zu rendernde Radarwerte müssen ein 2D-Integer-Raster sein")
    height, width = values.shape
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    mask = np.zeros((height, width, 4), dtype=np.uint8)
    is_missing = values == nodata
    is_undetect = values == undetect
    is_valid_rain = (values != nodata) & (values != undetect)
    rate = np.maximum(0, values.astype(np.float64) * gain + offset)
    breaks = (0.1, 0.5, 1, 2, 5, 10, 20)
    colors = ((118, 235, 255), (69, 190, 255), (58, 219, 132), (220, 236, 62),
              (255, 170, 38), (246, 73, 54), (217, 61, 227), (255, 255, 255))
    for index, color in enumerate(colors):
        lower = 0 if index == 0 else breaks[index - 1]
        upper = breaks[index] if index < len(breaks) else np.inf
        selected = is_valid_rain & (rate >= lower) & (rate < upper)
        rgba[selected, :3] = color
        rgba[selected, 3] = 220
    rows, cols = np.indices((height, width))
    hatch = is_missing & (((rows + cols) % 4 < 2) | ((rows - cols) % 13 == 0))
    mask[hatch] = (212, 219, 225, 130)
    counts = {"pixels": int(values.size), "rainPixels": int(np.count_nonzero(is_valid_rain)),
              "undetectPixels": int(np.count_nonzero(is_undetect)), "noDataPixels": int(np.count_nonzero(is_missing))}
    return Image.fromarray(rgba), Image.fromarray(mask), counts


def atomic_json(path: Path, content: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(content, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def decode_to_maplibre(grid: RadolanGrid, output_dir: Path, bounds: tuple[float, float, float, float] = OUTPUT_BOUNDS,
                       resolution_m: int = OUTPUT_RESOLUTION_M) -> dict[str, Any]:
    crop = geographic_crop(bounds, resolution_m)
    rows, cols, in_source = source_indices(grid, crop)
    cropped = np.full((crop["height"], crop["width"]), grid.nodata, dtype=grid.values.dtype)
    cropped[in_source] = grid.values[rows[in_source], cols[in_source]]
    image, coverage_mask, counts = colorize(cropped, grid.nodata, grid.undetect, grid.gain, grid.offset)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    image_name, mask_name = "radolan-ry-latest.png", "radolan-ry-coverage.png"
    image.save(output_dir / image_name, format="PNG", optimize=True)
    coverage_mask.save(output_dir / mask_name, format="PNG", optimize=True)
    age_minutes = (grid.retrieved_at - grid.product_end).total_seconds() / 60
    status = "unavailable" if age_minutes < -1 else "stale" if age_minutes > MAX_AGE_MINUTES else "current"
    meta = {"status": status, "product": "RADOLAN-RY", "quantity": "RATE", "unit": "mm/h",
            "scale": {"gain": grid.gain, "offset": grid.offset}, "productStart": iso_utc(grid.product_start),
            "productTime": iso_utc(grid.product_end), "retrievedAt": iso_utc(grid.retrieved_at),
            "ageMinutes": round(age_minutes, 2), "staleAfterMinutes": MAX_AGE_MINUTES,
            "source": SOURCE, "sourceUrl": SOURCE_URL, "attribution": "Daten: Deutscher Wetterdienst (DWD), RADOLAN-RY",
            "crs": "EPSG:3857", **crop, "image": image_name, "coverageMask": mask_name,
            "coverage": {**counts, "outsideSourcePixels": int(cropped.size - np.count_nonzero(in_source)),
                         "rainEquivalentMmPerHour": [0.1, 0.5, 1, 2, 5, 10, 20]},
            "sourceGrid": {"width": grid.xsize, "height": grid.ysize, "pixelSizeM": [grid.xscale, grid.yscale],
                           "projection": grid.projdef, "nodata": grid.nodata, "undetect": grid.undetect,
                           "inputSizeBytes": grid.source_size, "inputSha256": grid.sha256},
            "interpretation": {"rainPixels": "positive measured rate", "undetectPixels": "DWD undetect value; rendered transparent, not an all-clear",
                               "noDataPixels": "DWD no-data/outside coverage; shown with gray hatching"}}
    atomic_json(output_dir / "radolan-ry.json", meta)
    return meta


def mark_unavailable(output_dir: Path, error: Exception, checked_at: datetime | None = None) -> dict[str, Any]:
    """Publish an explicit failed state and never leave an old raster marked current."""
    output_dir = Path(output_dir)
    previous: dict[str, Any] = {}
    state_path = output_dir / "radolan-ry.json"
    try:
        previous = json.loads(state_path.read_text(encoding="utf-8"))
        if not isinstance(previous, dict):
            previous = {}
    except (OSError, ValueError):
        pass
    now = checked_at or datetime.now(timezone.utc)
    safe_message = " ".join(f"{type(error).__name__}: {error}".split())[:400]
    state = {"status": "unavailable", "product": "RADOLAN-RY", "source": SOURCE,
             "sourceUrl": SOURCE_URL, "lastAttemptAt": iso_utc(now), "lastError": safe_message,
             "image": None, "coverageMask": None, "productTime": None, "retrievedAt": None,
             "lastValidProductTime": previous.get("productTime") or previous.get("lastValidProductTime"),
             "staleAfterMinutes": MAX_AGE_MINUTES,
             "interpretation": {"status": "DWD-Quelle nicht verfügbar; es wird kein Radarbild als aktuell dargestellt."}}
    atomic_json(state_path, state)
    return state


def download_latest(directory: Path, now: datetime | None = None) -> tuple[Path, str, datetime]:
    name, product_time = find_latest_product(now)
    body, _, final_url = _fetch(urllib.parse.urljoin(DWD_DIRECTORY, name), MAX_DOWNLOAD_BYTES)
    if Path(urllib.parse.urlparse(final_url).path).name != name or not body.startswith(b"\x89HDF\r\n\x1a\n"):
        raise ValueError("DWD-Datei stimmt nicht mit ausgewähltem RY-HDF5-Produkt überein")
    destination = Path(directory) / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=f".{name}.", suffix=".tmp", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, destination)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return destination, name, product_time


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, help="Lokale DWD-RY-HDF5-Datei")
    parser.add_argument("--fetch-latest", action="store_true", help="Jüngste RY-Datei direkt von DWD laden")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "output")
    parser.add_argument("--download-directory", type=Path, default=Path(__file__).resolve().parent / "downloads")
    args = parser.parse_args()
    if bool(args.input) == args.fetch_latest:
        parser.error("Genau eine Eingabe wählen: --input DATEI oder --fetch-latest")
    retrieved_at = datetime.now(timezone.utc)
    try:
        source_path = args.input
        if args.fetch_latest:
            source_path, _, _ = download_latest(args.download_directory, retrieved_at)
        grid = read_product(source_path, retrieved_at)
        metadata = decode_to_maplibre(grid, args.output)
    except Exception as exc:
        state = mark_unavailable(args.output, exc, retrieved_at)
        print(json.dumps({"status": state["status"], "lastAttemptAt": state["lastAttemptAt"],
                          "lastValidProductTime": state["lastValidProductTime"], "error": state["lastError"]}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps({"status": metadata["status"], "productTime": metadata["productTime"],
                      "retrievedAt": metadata["retrievedAt"], "ageMinutes": metadata["ageMinutes"],
                      "imageSizeBytes": (args.output / metadata["image"]).stat().st_size,
                      "coverageMaskSizeBytes": (args.output / metadata["coverageMask"]).stat().st_size,
                      "coverage": metadata["coverage"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
