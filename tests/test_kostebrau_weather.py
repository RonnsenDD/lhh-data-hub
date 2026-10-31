import json
import unittest
from datetime import datetime, timezone

from src.kostebrau_weather import SourceError, build_snapshot, parse_station

HTML = """
<h2>31.10.2026 07:50:00</h2>
Außentemperatur 7,2°C Luftfeuchte 99% Luftdruck 1014,4 mbar
Windgeschwindigkeit 6 km/h W Böen Geschwindigkeit 11 km/h W
Regen 0,00 cm Gesamt Regen-Rate 0,00 cm/h Max Regen-Rate 0,12 cm/h
"""
MODEL = json.dumps({"current": {"weather_code": 3, "is_day": 1, "time": "2026-10-31T08:00"}}).encode()


class KostebrauWeatherTests(unittest.TestCase):
    def test_legacy_contract_and_separate_measurement_and_retrieval_times(self):
        data = build_snapshot(HTML, MODEL, datetime(2026, 10, 31, 6, 55, tzinfo=timezone.utc))
        self.assertEqual(data["station"]["name"], "DB0LS, Kostebrau")
        self.assertEqual(data["measuredAt"], "2026-10-31T07:50:00")
        self.assertEqual(data["measuredAtUtc"], "2026-10-31T06:50:00Z")
        self.assertEqual(data["retrievedAt"], "2026-10-31T06:55:00.000Z")
        self.assertEqual(data["status"], "ok")
        for field in ("temperatureC", "humidityPercent", "pressureHpa", "windKmh", "windDirection",
                      "gustKmh", "gustDirection", "rainTotalCm", "rainRateCmH", "maxRainRateCmH"):
            self.assertIn(field, data)

    def test_source_measurement_over_45_minutes_is_stale(self):
        data = build_snapshot(HTML, MODEL, datetime(2026, 10, 31, 8, 0, tzinfo=timezone.utc))
        self.assertEqual(data["status"], "stale")
        self.assertIn("45 Minuten", data["statusReason"])

    def test_future_measurement_is_rejected(self):
        with self.assertRaisesRegex(SourceError, "future"):
            build_snapshot(HTML, MODEL, datetime(2026, 10, 31, 5, 0, tzinfo=timezone.utc))

    def test_ambiguous_dst_wall_time_is_never_claimed_current(self):
        data = build_snapshot(HTML.replace("31.10.2026 07:50:00", "25.10.2026 02:30:00"),
                              MODEL, datetime(2026, 10, 25, 1, 35, tzinfo=timezone.utc))
        self.assertTrue(data["timestampAmbiguous"])
        self.assertIsNone(data["measuredAtUtc"])
        self.assertEqual(data["status"], "stale")

    def test_nonexistent_dst_wall_time_and_missing_fields_fail_closed(self):
        with self.assertRaisesRegex(SourceError, "nonexistent"):
            parse_station(HTML.replace("31.10.2026 07:50:00", "29.03.2026 02:30:00"))
        with self.assertRaisesRegex(SourceError, "Required"):
            parse_station("<h2>31.10.2026 07:50:00</h2>")

    def test_invalid_model_response_fails_closed(self):
        with self.assertRaises(SourceError):
            build_snapshot(HTML, b"{bad", datetime(2026, 10, 31, 6, 55, tzinfo=timezone.utc))


if __name__ == "__main__":
    unittest.main()
