import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlsplit

from restore_previous import deployment_blockers, restore_previous


def png(seed: int) -> bytes:
    # The restore helper validates the PNG signature and digest; a real RGBA test PNG is unnecessary here.
    return bytes((137, 80, 78, 71, 13, 10, 26, 10)) + bytes((seed,)) * 24


class RestorePreviousTests(unittest.TestCase):
    def setUp(self):
        self.frame_id = "20261030T060000Z"
        self.rain = png(1)
        self.coverage = png(2)
        self.geo = json.dumps({
            "type": "FeatureCollection",
            "properties": {"referenceTime": "2026-10-30T06:00:00.000Z"},
            "features": []
        }, separators=(",", ":")).encode() + b"\n"
        self.radar_manifest = {
            "schemaVersion": 1, "product": "RADOLAN-RY", "status": "current",
            "frameId": self.frame_id, "productTime": "2026-10-30T06:00:00Z",
            "rainImage": f"frames/{self.frame_id}/rain.png",
            "coverageImage": f"frames/{self.frame_id}/coverage.png",
            "imageSha256": hashlib.sha256(self.rain).hexdigest(),
            "coverageSha256": hashlib.sha256(self.coverage).hexdigest()
        }
        self.konrad_manifest = {
            "schemaVersion": 1, "product": "DWD KONRAD3D", "status": "current",
            "referenceTime": "2026-10-30T06:00:00.000Z", "cellsGeoJSON": "cells.geojson",
            "cellsGeoJSONSha256": hashlib.sha256(self.geo).hexdigest()
        }
        self.resources = {
            "/lhh-data-hub/radar/latest.json": json.dumps(self.radar_manifest).encode(),
            f"/lhh-data-hub/radar/frames/{self.frame_id}/rain.png": self.rain,
            f"/lhh-data-hub/radar/frames/{self.frame_id}/coverage.png": self.coverage,
            "/lhh-data-hub/konrad3d/latest.json": json.dumps(self.konrad_manifest).encode(),
            "/lhh-data-hub/konrad3d/cells.geojson": self.geo,
        }

    def fake_fetch(self, url, accept, limit):
        key = urlsplit(url).path
        if key not in self.resources:
            raise OSError(f"not found: {key}")
        result = self.resources[key]
        if len(result) > limit:
            raise ValueError("too large")
        return result

    def test_deployment_gate_blocks_failed_producer_only_when_pages_lookup_failed(self):
        report = {
            "radar": {"result": "error"},
            "konrad3d": {"result": "restored"},
        }
        self.assertEqual(
            deployment_blockers(report, {"radar": "failure", "konrad3d": "failure"}),
            ["radar"],
        )

    def test_deployment_gate_allows_successful_replacement_after_pages_lookup_failure(self):
        report = {
            "radar": {"result": "error"},
            "konrad3d": {"result": "missing"},
        }
        self.assertEqual(
            deployment_blockers(report, {"radar": "success", "konrad3d": "failure"}),
            [],
        )

    def test_workflow_restores_before_producers_and_gates_pages_upload(self):
        workflow = Path(__file__).resolve().parents[2] / ".github/workflows/update-radolan-ry.yml"
        source = workflow.read_text(encoding="utf-8")
        restore = source.index("tools/radolan-ry/restore_previous.py --site-dir")
        radar = source.index("id: radar", restore)
        konrad = source.index("id: konrad", radar)
        gate = source.index("Bei Pages-Ausfall keinen unvollständigen Stand veröffentlichen", konrad)
        upload = source.index("Pages-Artefakt hochladen", gate)
        self.assertLess(restore, radar)
        self.assertLess(radar, konrad)
        self.assertLess(konrad, gate)
        self.assertLess(gate, upload)
        dollar = chr(36)
        self.assertIn("RADAR_PRODUCER_OUTCOME: " + dollar + "{{ steps.radar.outcome }}", source)
        self.assertIn("KONRAD_PRODUCER_OUTCOME: " + dollar + "{{ steps.konrad.outcome }}", source)
        self.assertIn("7,22,37,52 * * * *", source)

    def test_restores_both_products_with_frame_hashes_and_independent_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            site = Path(temp)
            result = restore_previous(site, fetcher=self.fake_fetch)
            self.assertEqual(result["radar"]["result"], "restored")
            self.assertEqual(result["konrad3d"]["result"], "restored")
            self.assertTrue((site / "radar" / "latest.json").is_file())
            self.assertEqual((site / "radar" / "frames" / self.frame_id / "rain.png").read_bytes(), self.rain)
            self.assertEqual((site / "radar" / "frames" / self.frame_id / "coverage.png").read_bytes(), self.coverage)
            self.assertEqual((site / "konrad3d" / "cells.geojson").read_bytes(), self.geo)
            self.assertTrue((site / "konrad3d" / "latest.json").is_file())

    def test_failure_of_one_product_does_not_block_restoration_of_the_other(self):
        with tempfile.TemporaryDirectory() as temp:
            site = Path(temp)
            resources = dict(self.resources)
            del resources["/lhh-data-hub/konrad3d/latest.json"]
            def fetch(url, accept, limit):
                key = urlsplit(url).path
                if key not in resources:
                    raise FileNotFoundError(key)
                return resources[key]
            result = restore_previous(site, fetcher=fetch)
            self.assertEqual(result["radar"]["result"], "restored")
            self.assertEqual(result["konrad3d"]["result"], "missing")
            self.assertTrue((site / "radar" / "latest.json").is_file())
            self.assertFalse((site / "konrad3d" / "latest.json").exists())

    def test_pages_transport_failure_is_distinguished_from_missing_snapshot(self):
        with tempfile.TemporaryDirectory() as temp:
            site = Path(temp)
            result = restore_previous(site, fetcher=lambda *_: (_ for _ in ()).throw(ConnectionError("HTTP 503")))
            self.assertEqual(result["radar"]["result"], "error")
            self.assertEqual(result["konrad3d"]["result"], "error")

    def test_checksum_mismatch_is_not_restored(self):
        with tempfile.TemporaryDirectory() as temp:
            site = Path(temp)
            self.resources["/lhh-data-hub/radar/frames/20261030T060000Z/rain.png"] = png(9)
            result = restore_previous(site, fetcher=self.fake_fetch)
            self.assertEqual(result["radar"]["result"], "invalid")
            self.assertIn("Prüfsumme stimmt nicht", result["radar"]["reason"])
            self.assertFalse((site / "radar" / "latest.json").exists())
            self.assertEqual(result["konrad3d"]["result"], "restored")


if __name__ == "__main__":
    unittest.main()
