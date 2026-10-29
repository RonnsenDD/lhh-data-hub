"""Publication-contract tests use the checked-in historical snapshot as a fixture only."""
from __future__ import annotations

import copy
import json
import unittest
from datetime import datetime, timezone
from pathlib import Path

from src.validate_dwd_weather_schema import validate, validate_publication

ROOT = Path(__file__).resolve().parents[1]


class DwdPublicationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = json.loads((ROOT / "docs/dwd-weather-v2.schema.json").read_text())
        cls.fixture = json.loads((ROOT / "data/generated/dwd-weather.json").read_text())

    def snapshot(self):
        value = copy.deepcopy(self.fixture)
        fixed_now = "2026-10-18T18:08:13Z"
        value["lastAttemptAt"] = fixed_now
        for observation in value["observations"].values():
            observation["retrievedAt"] = fixed_now
            measured = datetime.fromisoformat(observation["measuredAt"].replace("Z", "+00:00"))
            retrieved = datetime.fromisoformat(fixed_now.replace("Z", "+00:00"))
            observation["ageMinutes"] = round((retrieved - measured).total_seconds() / 60, 1)
        forecast = value["forecast"]
        forecast["retrievedAt"] = fixed_now
        issued = datetime.fromisoformat(forecast["issuedAt"].replace("Z", "+00:00"))
        retrieved = datetime.fromisoformat(fixed_now.replace("Z", "+00:00"))
        forecast["ageHours"] = round((retrieved - issued).total_seconds() / 3600, 2)
        return value, retrieved

    def test_historical_fixture_conforms_to_json_v2_schema(self):
        self.assertEqual(validate(self.fixture, self.schema), [])

    def test_fresh_complete_snapshot_passes_publication_contract(self):
        value, now = self.snapshot()
        self.assertEqual(validate_publication(value, self.schema, now=now), [])

    def test_stale_measurement_is_permitted_only_with_stale_status(self):
        value, now = self.snapshot()
        obs = value["observations"]["wind"]
        obs["measuredAt"] = "2026-10-18T16:00:00Z"
        obs["ageMinutes"] = 128.2
        obs["status"] = "stale"
        value["status"] = "partial"
        self.assertEqual(validate_publication(value, self.schema, now=now), [])

    def test_error_status_is_never_publishable(self):
        value, now = self.snapshot()
        value["status"] = "partial"
        value["observations"]["wind"]["status"] = "error"
        errors = validate_publication(value, self.schema, now=now)
        self.assertTrue(any("technical source errors" in item for item in errors))

    def test_old_attempt_is_rejected_even_when_schema_is_valid(self):
        value, now = self.snapshot()
        value["lastAttemptAt"] = "2026-10-18T17:00:00Z"
        errors = validate_publication(value, self.schema, now=now)
        self.assertTrue(any("lastAttemptAt: attempt is older" in item for item in errors))

    def test_workflow_ten_minute_attempt_limit_rejects_historical_snapshot(self):
        value, _ = self.snapshot()
        value["lastAttemptAt"] = "2026-10-18T18:08:13Z"
        now = datetime.fromisoformat("2026-10-18T18:37:09+00:00")
        errors = validate_publication(value, self.schema, now=now, max_attempt_age_minutes=10)
        self.assertTrue(any("lastAttemptAt: attempt is older than 10 minutes" in item for item in errors))

    def test_source_url_and_attribution_are_required(self):
        value, now = self.snapshot()
        value["observations"]["wind"]["source"]["url"] = "http://example.invalid/data"
        value["forecast"]["source"]["license"] = "missing"
        errors = validate_publication(value, self.schema, now=now)
        self.assertTrue(any("expected an HTTPS official DWD" in item for item in errors))
        self.assertTrue(any("CC BY 4.0 attribution missing" in item for item in errors))

    def test_ok_status_cannot_contradict_age(self):
        value, now = self.snapshot()
        value["observations"]["wind"]["measuredAt"] = "2026-10-18T16:00:00Z"
        value["observations"]["wind"]["ageMinutes"] = 128.2
        errors = validate_publication(value, self.schema, now=now)
        self.assertTrue(any("ok contradicts the freshness threshold" in item for item in errors))

    def test_age_metadata_must_match_timestamps(self):
        value, now = self.snapshot()
        value["forecast"]["ageHours"] += 1
        errors = validate_publication(value, self.schema, now=now)
        self.assertTrue(any("ageHours: inconsistent" in item for item in errors))


if __name__ == "__main__":
    unittest.main()
