from __future__ import annotations

import unittest

from src.validate_dwd_weather_freshness import validate_manifest


def manifest():
    statuses = ["ok", "stale", "ok", "unavailable", "ok"]
    observations = {}
    for key, status in zip(("temperatureHumidity", "stationPressure", "wind", "windGust", "precipitation"), statuses):
        observations[key] = {
            "status": status,
            "measuredAt": "2026-11-01T08:50:00Z" if status != "unavailable" else None,
            "retrievedAt": "2026-11-01T09:22:50Z",
            "freshnessThresholdMinutes": 60,
            "availableFields": ["temperatureC"] if status != "unavailable" else [],
        }
    return {
        "schemaVersion": 1,
        "source": "DWD weather snapshot v2",
        "sourceStatus": "ok",
        "lastAttemptAt": "2026-11-01T09:22:50Z",
        "lastSuccessfulAt": None,
        "snapshotPublishedAt": None,
        "derivedAt": "2026-11-01T09:22:58Z",
        "observations": observations,
        "forecast": {
            "status": "ok",
            "issuedAt": "2026-11-01T03:00:00Z",
            "retrievedAt": "2026-11-01T09:22:50Z",
            "validAt": "2026-11-01T10:00:00Z",
            "validThrough": "2026-11-11T10:00:00Z",
            "hasUsablePoint": True,
            "usableValidTimes": ["2026-11-01T10:00:00Z", "2026-11-01T11:00:00Z"],
        },
    }


class FreshnessValidatorTests(unittest.TestCase):
    def test_accepts_new_manifest_with_multiple_usable_points(self):
        validate_manifest(manifest(), require_usable_valid_times=True)

    def test_old_v1_manifest_remains_backward_compatible_unless_publication_requires_extension(self):
        doc = manifest()
        del doc["forecast"]["usableValidTimes"]
        validate_manifest(doc)
        with self.assertRaisesRegex(ValueError, "usableValidTimes is required"):
            validate_manifest(doc, require_usable_valid_times=True)

    def test_rejects_unsorted_or_duplicate_times(self):
        doc = manifest()
        doc["forecast"]["usableValidTimes"] = ["2026-11-01T11:00:00Z", "2026-11-01T10:00:00Z"]
        with self.assertRaisesRegex(ValueError, "chronologically ordered"):
            validate_manifest(doc, require_usable_valid_times=True)
        doc["forecast"]["usableValidTimes"] = ["2026-11-01T10:00:00Z", "2026-11-01T10:00:00+00:00"]
        with self.assertRaisesRegex(ValueError, "chronologically ordered"):
            validate_manifest(doc, require_usable_valid_times=True)

    def test_rejects_contradictory_next_time_or_usability_flag(self):
        doc = manifest()
        doc["forecast"]["validAt"] = "2026-11-01T11:00:00Z"
        with self.assertRaisesRegex(ValueError, "validAt must equal"):
            validate_manifest(doc, require_usable_valid_times=True)
        doc = manifest()
        doc["forecast"]["hasUsablePoint"] = False
        with self.assertRaisesRegex(ValueError, "contradicts usableValidTimes"):
            validate_manifest(doc, require_usable_valid_times=True)


if __name__ == "__main__":
    unittest.main()
