"""Freshness sidecar preserves source time and omits large data payloads."""
from __future__ import annotations

import unittest

from scripts.create_dwd_weather_freshness_manifest import create_manifest


def snapshot():
    observations = {
        "temperatureHumidity": {
            "status": "ok", "measuredAt": "2026-11-01T01:20:00Z",
            "freshnessThresholdMinutes": 60,
            "values": {"temperatureC": 6.3, "relativeHumidityPercent": 94.4,
                       "dewPointC": 5.5},
        },
        "stationPressure": {
            "status": "stale", "measuredAt": "2026-11-01T00:00:00Z",
            "freshnessThresholdMinutes": 60, "values": {"stationPressureHpa": 1018.4},
        },
        "wind": {
            "status": "ok", "measuredAt": "2026-11-01T01:20:00Z",
            "freshnessThresholdMinutes": 60,
            "values": {"windSpeedKmh": 10.08, "windDirectionDeg": 10},
        },
        "windGust": {
            "status": "unavailable", "measuredAt": None,
            "freshnessThresholdMinutes": 60, "values": {},
        },
        "precipitation": {
            "status": "ok", "measuredAt": "2026-11-01T01:20:00Z",
            "freshnessThresholdMinutes": 60,
            "values": {"precipitation10MinMm": 0},
        },
    }
    return {
        "schemaVersion": 2, "status": "partial", "lastAttemptAt": "2026-11-01T01:25:00Z",
        "lastSuccessfulAt": "2026-11-01T01:25:00Z", "publishedAt": "2026-11-01T01:25:02Z",
        "observations": observations,
        "forecast": {"status": "ok", "issuedAt": "2026-11-01T00:00:00Z",
                     "points": [{"validAt": "2026-11-01T02:00:00Z", "values": {"T": 4}}]},
    }


class FreshnessManifestTests(unittest.TestCase):
    def test_preserves_source_times_and_producer_states_without_copying_values_or_points(self):
        doc = create_manifest(snapshot(), derived_at="2026-11-01T01:30:00Z")
        self.assertEqual(doc["sourceStatus"], "partial")
        self.assertEqual(doc["snapshotPublishedAt"], "2026-11-01T01:25:02Z")
        self.assertEqual(doc["derivedAt"], "2026-11-01T01:30:00Z")
        self.assertEqual(doc["observations"]["temperatureHumidity"]["measuredAt"],
                         "2026-11-01T01:20:00Z")
        self.assertEqual(doc["observations"]["stationPressure"]["status"], "stale")
        self.assertEqual(doc["observations"]["windGust"]["measuredAt"], None)
        self.assertEqual(doc["observations"]["precipitation"]["availableFields"],
                         ["precipitation10MinMm"])
        self.assertNotIn("values", doc["observations"]["precipitation"])
        self.assertNotIn("points", doc["forecast"])
        self.assertEqual(doc["forecast"]["issuedAt"], "2026-11-01T00:00:00Z")
        self.assertEqual(doc["forecast"]["usableValidTimes"], ["2026-11-01T02:00:00Z"])
        self.assertEqual(doc["forecast"]["validAt"], doc["forecast"]["usableValidTimes"][0])

    def test_does_not_use_derived_or_published_time_as_a_source_timestamp(self):
        value = snapshot()
        value["observations"]["wind"]["measuredAt"] = None
        doc = create_manifest(value, derived_at="2026-11-01T02:00:00Z")
        self.assertIsNone(doc["observations"]["wind"]["measuredAt"])

    def test_rejects_wrong_schema_or_unknown_product_status(self):
        value = snapshot()
        value["schemaVersion"] = 1
        with self.assertRaisesRegex(ValueError, "schemaVersion 2"):
            create_manifest(value)
        value = snapshot()
        value["forecast"]["status"] = "fresh"
        with self.assertRaisesRegex(ValueError, "forecast.status"):
            create_manifest(value)

    def test_unavailable_forecast_without_points_remains_explicitly_unavailable(self):
        value = snapshot()
        value["forecast"] = {"status": "unavailable", "issuedAt": None}
        manifest = create_manifest(value, derived_at="2026-11-01T01:30:00Z")
        self.assertEqual(manifest["forecast"]["status"], "unavailable")
        self.assertFalse(manifest["forecast"]["hasUsablePoint"])
        self.assertIsNone(manifest["forecast"]["validAt"])
        self.assertEqual(manifest["forecast"]["usableValidTimes"], [])

    def test_usable_valid_times_are_sorted_deduplicated_and_require_finite_values(self):
        value = snapshot()
        value["forecast"]["points"] = [
            {"validAt": "2026-11-01T04:00:00Z", "values": {"T": 4}},
            {"validAt": "2026-11-01T03:00:00Z", "values": {"T": None}},
            {"validAt": "2026-11-01T03:00:00+00:00", "values": {"T": 5}},
            {"validAt": "2026-11-01T05:00:00Z", "values": {"T": True}},
            {"validAt": "2026-11-01T06:00:00Z", "values": {"T": float("nan")}},
            {"validAt": "not-a-time", "values": {"T": 7}},
        ]
        doc = create_manifest(value, derived_at="2026-11-01T02:30:00Z")
        self.assertEqual(
            doc["forecast"]["usableValidTimes"],
            ["2026-11-01T03:00:00+00:00", "2026-11-01T04:00:00Z"],
        )
        self.assertEqual(doc["forecast"]["validAt"], "2026-11-01T03:00:00+00:00")

    def test_generated_at_does_not_make_past_points_usable(self):
        value = snapshot()
        value["forecast"]["points"] = [
            {"validAt": "2026-11-01T01:00:00Z", "values": {"T": 8}},
        ]
        doc = create_manifest(value, derived_at="2026-11-01T02:30:00Z")
        self.assertFalse(doc["forecast"]["hasUsablePoint"])
        self.assertEqual(doc["forecast"]["usableValidTimes"], [])


if __name__ == "__main__":
    unittest.main()
