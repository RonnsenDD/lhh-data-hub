"""Publication-contract tests use a deterministic historical fixture; no live snapshot is required."""
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
        # Stable historical fixture, intentionally independent of the generated
        # production snapshot (which is created only after this offline test step).
        observed = "2026-10-18T18:00:00Z"
        retrieved = "2026-10-18T18:08:13Z"
        local_observed = "2026-10-18T20:00:00+02:00"
        local_retrieved = "2026-10-18T20:08:13+02:00"
        cdc = "https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/10_minutes"
        stations = {
            "temperatureHumidity": ("02627", "Schipkau-Klettwitz", 51.5554, 13.8845, 12.7, "air_temperature/now/10minutenwerte_TU_02627_now.zip"),
            "stationPressure": ("01001", "Doberlug-Kirchhain", 51.6451, 13.5747, 23.5, "air_temperature/now/10minutenwerte_TU_01001_now.zip"),
            "wind": ("01001", "Doberlug-Kirchhain", 51.6451, 13.5747, 23.5, "wind/now/10minutenwerte_wind_01001_now.zip"),
            "windGust": ("01001", "Doberlug-Kirchhain", 51.6451, 13.5747, 23.5, "extreme_wind/now/10minutenwerte_extrema_wind_01001_now.zip"),
            "precipitation": ("02627", "Schipkau-Klettwitz", 51.5554, 13.8845, 12.7, "precipitation/now/10minutenwerte_nieder_02627_now.zip"),
        }
        values = {
            "temperatureHumidity": ({"temperatureC": 9.6, "relativeHumidityPercent": 95.6, "dewPointC": 8.9}, {"temperatureC": "°C", "relativeHumidityPercent": "%", "dewPointC": "°C"}),
            "stationPressure": ({"stationPressureHpa": 1016.7}, {"stationPressureHpa": "hPa"}),
            "wind": ({"windSpeedKmh": 3.6, "windDirectionDeg": 360.0}, {"windSpeedKmh": "km/h", "windDirectionDeg": "degree"}),
            "windGust": ({"windGustKmh": 5.4}, {"windGustKmh": "km/h"}),
            "precipitation": ({"precipitation10MinMm": 0.0}, {"precipitation10MinMm": "mm"}),
        }
        observations = {}
        for key, (station_id, name, lat, lon, distance, path) in stations.items():
            measured_values, units = values[key]
            observations[key] = {
                "status": "ok",
                "station": {"id": station_id, "name": name, "latitude": lat, "longitude": lon, "distanceKm": distance},
                "measuredAt": observed, "measuredAtLocal": local_observed,
                "retrievedAt": retrieved, "retrievedAtLocal": local_retrieved,
                "ageMinutes": 8.2, "freshnessThresholdMinutes": 60, "qualityLevel": 2,
                "units": units, "values": measured_values,
                "source": {"provider": "DWD Climate Data Center (CDC)", "url": f"{cdc}/{path}", "license": "CC BY 4.0"},
            }
        cls.fixture = {
            "schemaVersion": 2,
            "location": {"key": "lauchhammer", "name": "Lauchhammer", "latitude": 51.4693, "longitude": 13.76319},
            "status": "ok",
            "observations": observations,
            "forecast": {
                "provider": "Deutscher Wetterdienst (DWD), MOSMIX-L", "status": "ok",
                "stationId": "P0043", "stationName": "SENFTENBERG/LUB",
                "coordinates": {"latitude": 51.52, "longitude": 14.0}, "distanceKm": 17.34,
                "issuedAt": "2026-10-18T15:00:00Z", "issuedAtLocal": "2026-10-18T17:00:00+02:00",
                "retrievedAt": retrieved, "retrievedAtLocal": local_retrieved, "ageHours": 3.14,
                "models": [{"name": "ICON", "referenceTime": "2026-10-18T12:00:00Z"}],
                "points": [{"validAt": "2026-10-18T19:00:00Z", "validAtLocal": "2026-10-18T21:00:00+02:00",
                            "values": {"temperatureC": 12.0, "windDirectionDeg": 270, "windSpeedKmh": 7.2,
                                       "windGustKmh": 14.4, "precipitation1hMm": 0, "pressureHpa": 1013.25,
                                       "weatherCode": 3, "weatherSymbol": "cloud"}}],
                "source": {"url": "https://opendata.dwd.de/weather/local_forecasts/mos/MOSMIX_L/single_stations/P0043/kml/MOSMIX_L_LATEST_P0043.kmz",
                           "license": "DWD Open Data; CC BY 4.0 attribution applies"},
            },
            "lastAttemptAt": retrieved,
            "sourceNote": "Historical test fixture only; never publish as current weather.",
        }

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
