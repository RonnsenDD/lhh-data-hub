import json
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

import publish_pages as publisher

META = {
    "productTime": "2026-10-27T20:40:00Z",
    "productStart": "2026-10-27T20:35:00Z",
    "retrievedAt": "2026-10-27T20:43:00Z",
    "crs": "EPSG:3857",
    "width": 4,
    "height": 3,
    "resolutionM": 500,
    "imageCoordinates": [[13.3, 51.7], [14.3, 51.7], [14.3, 51.2], [13.3, 51.2]],
    "coverage": {"pixels": 12, "rainPixels": 2, "undetectPixels": 8, "noDataPixels": 2},
    "interpretation": {"noDataPixels": "coverage only"},
    "image": "radolan-ry-latest.png",
    "coverageMask": "radolan-ry-coverage.png",
}


class PagesArtifactTests(unittest.TestCase):
    def make_rasters(self, directory):
        Image.new("RGBA", (4, 3), (20, 50, 200, 100)).save(Path(directory) / META["image"], format="PNG")
        Image.new("RGBA", (4, 3), (100, 100, 100, 80)).save(Path(directory) / META["coverageMask"], format="PNG")

    def test_manifest_and_both_pngs_reference_one_frame(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            raster_dir = root / "decoder"
            raster_dir.mkdir()
            self.make_rasters(raster_dir)
            site = root / "site"
            result = publisher.publish(site, META, raster_dir)
            self.assertTrue((site / "index.html").is_file())
            expected = "20261027T204000Z"
            self.assertEqual(result["frameId"], expected)
            self.assertEqual(result["status"], "stale")
            self.assertEqual(result["rainImage"], f"frames/{expected}/rain.png")
            self.assertEqual(result["coverageImage"], f"frames/{expected}/coverage.png")
            self.assertTrue((site / "radar" / result["rainImage"]).is_file())
            self.assertTrue((site / "radar" / result["coverageImage"]).is_file())
            saved = json.loads((site / "radar" / "latest.json").read_text(encoding="utf-8"))
            self.assertEqual(saved["frameId"], expected)
            self.assertEqual(saved["imageSha256"], result["imageSha256"])
            self.assertEqual(saved["bounds"], {"west": 13.35, "south": 51.25, "east": 14.2, "north": 51.75})

    def test_only_one_frame_is_kept_and_no_hdf_is_published(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            raster_dir = root / "decoder"
            raster_dir.mkdir()
            self.make_rasters(raster_dir)
            site = root / "site"
            frames = site / "radar" / "frames"
            (frames / "old-frame").mkdir(parents=True)
            (frames / "old-frame" / "old.hdf5").write_bytes(b"not published")
            publisher.publish(site, META, raster_dir)
            self.assertEqual([p.name for p in frames.iterdir()], ["20261027T204000Z"])
            self.assertFalse(any(frames.rglob("*.hdf5")))

    def test_unavailable_keeps_checksum_verified_last_frame_and_marks_it_stale(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            raster_dir = root / "decoder"
            raster_dir.mkdir()
            self.make_rasters(raster_dir)
            site = root / "site"
            previous = publisher.publish(site, META, raster_dir)
            rain = site / "radar" / previous["rainImage"]
            coverage = site / "radar" / previous["coverageImage"]
            rain_bytes, coverage_bytes = rain.read_bytes(), coverage.read_bytes()

            result = publisher.unavailable(site, OSError("HTTP 503"), datetime(2026, 10, 27, 21, 0, tzinfo=timezone.utc))

            self.assertTrue((site / "index.html").is_file())
            self.assertEqual(result["status"], "stale")
            self.assertEqual(result["fetchStatus"], "error")
            self.assertEqual(result["error"], "OSError: HTTP 503")
            self.assertEqual(result["frameId"], previous["frameId"])
            self.assertEqual(result["productTime"], META["productTime"])
            self.assertEqual(result["ageMinutes"], 20)
            self.assertEqual(rain.read_bytes(), rain_bytes)
            self.assertEqual(coverage.read_bytes(), coverage_bytes)
            self.assertEqual(result["imageSha256"], previous["imageSha256"])
            self.assertEqual(result["coverageSha256"], previous["coverageSha256"])
            self.assertEqual([p.name for p in (site / "radar" / "frames").iterdir()], [previous["frameId"]])

    def test_run_fetch_failure_keeps_the_seeded_public_frame(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            raster_dir = root / "decoder"
            raster_dir.mkdir()
            self.make_rasters(raster_dir)
            site = root / "site"
            previous = publisher.publish(site, META, raster_dir)
            with patch.object(publisher.decoder, "download_latest", side_effect=OSError("HTTP 503")):
                with self.assertRaisesRegex(OSError, "HTTP 503"):
                    publisher.run(site, root / "downloads")
            manifest = json.loads((site / "radar" / "latest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["fetchStatus"], "error")
            self.assertEqual(manifest["frameId"], previous["frameId"])
            self.assertTrue((site / "radar" / previous["rainImage"]).is_file())
            self.assertTrue((site / "radar" / previous["coverageImage"]).is_file())

    def test_unavailable_without_validated_previous_frame_has_no_images(self):
        with tempfile.TemporaryDirectory() as temp:
            site = Path(temp) / "site"
            error = publisher.unavailable(site, OSError("HTTP 503"), datetime(2026, 10, 27, tzinfo=timezone.utc))
            self.assertEqual(error["status"], "unavailable")
            self.assertEqual(error["fetchStatus"], "error")
            self.assertIsNone(error["rainImage"])
            self.assertIsNone(error["coverageImage"])
            self.assertEqual(list((site / "radar" / "frames").iterdir()), [])

    def test_older_product_cannot_replace_a_newer_last_good_frame(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            raster_dir = root / "decoder"
            raster_dir.mkdir()
            self.make_rasters(raster_dir)
            site = root / "site"
            previous = publisher.publish(site, META, raster_dir)
            older = {**META, "productTime": "2026-10-27T20:35:00Z"}
            with self.assertRaisesRegex(ValueError, "älter als der letzte"):
                publisher.publish(site, older, raster_dir)
            manifest = json.loads((site / "radar" / "latest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["frameId"], previous["frameId"])
            self.assertTrue((site / "radar" / previous["rainImage"]).is_file())


if __name__ == "__main__":
    unittest.main()

