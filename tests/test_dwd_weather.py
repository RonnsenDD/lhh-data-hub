import io
import json
import tempfile
import unittest
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from unittest.mock import patch

from src.dwd_weather import (
    DwdSourceError,
    mark_error,
    parse_cdc_observations,
    parse_dwd_timestamp,
    run,
)


def make_zip(csv_text: str) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("produkt_tu_stunde_02627.txt", csv_text)
    return buffer.getvalue()


class DwdWeatherTests(unittest.TestCase):
    def test_selects_latest_valid_timestamp_in_utc_and_preserves_values(self):
        payload = make_zip(
            "MESS_DATUM;QN;PP_10;TT_10;RF_10;TD_10;eor\n"
            "202610181300;3;1000.2;11.5;72;6.3;eor\n"
            "202610181310;3;-999;-999;-999;-999;eor\n"
            "202610181320;2;999.8;12.1;70;6.8;eor\n"
        )
        result = parse_cdc_observations(payload, datetime(2026, 10, 18, 13, 25, tzinfo=timezone.utc))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["observation"]["measuredAt"], "2026-10-18T13:20:00Z")
        self.assertEqual(result["observation"]["values"]["temperatureC"], 12.1)
        self.assertEqual(result["observation"]["values"]["relativeHumidityPercent"], 70.0)
        self.assertEqual(result["observation"]["qualityLevel"], 2)

    def test_dwd_timestamp_is_utc_and_accepts_hour_precision(self):
        self.assertEqual(parse_dwd_timestamp("2026101813").isoformat(), "2026-10-18T13:00:00+00:00")
        self.assertEqual(parse_dwd_timestamp("202610181320").tzinfo, timezone.utc)
        winter = parse_dwd_timestamp("202601151200").astimezone(ZoneInfo("Europe/Berlin"))
        summer = parse_dwd_timestamp("202607151200").astimezone(ZoneInfo("Europe/Berlin"))
        self.assertEqual(winter.hour, 13)
        self.assertEqual(summer.hour, 14)

    def test_old_measurement_is_stale_even_if_download_is_recent(self):
        payload = make_zip("MESS_DATUM;QN;PP_10;TT_10;RF_10;TD_10\n202610180900;3;1001;10;60;2\n")
        result = parse_cdc_observations(payload, datetime(2026, 10, 18, 11, 0, tzinfo=timezone.utc))
        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["observation"]["ageMinutes"], 120)

    def test_missing_and_sentinel_values_remain_unavailable(self):
        payload = make_zip("MESS_DATUM;QN;PP_10;TT_10;RF_10;TD_10\n202610181320;1;-999;12.0;-999;-999\n")
        result = parse_cdc_observations(payload, datetime(2026, 10, 18, 13, 25, tzinfo=timezone.utc))
        self.assertEqual(result["status"], "partial")
        values = result["observation"]["values"]
        self.assertEqual(values["temperatureC"], 12.0)
        self.assertIsNone(values["relativeHumidityPercent"])
        self.assertIsNone(values["stationPressureHpa"])

    def test_bad_zip_and_missing_columns_fail_closed(self):
        with self.assertRaises(DwdSourceError):
            parse_cdc_observations(b"not zip", datetime.now(timezone.utc))
        with self.assertRaises(DwdSourceError):
            parse_cdc_observations(make_zip("MESS_DATUM;TT_10\n202610181320;12\n"), datetime.now(timezone.utc))

    def test_forecast_stays_separate_and_unavailable(self):
        payload = make_zip("MESS_DATUM;QN;PP_10;TT_10;RF_10;TD_10\n202610181320;3;1000;12;70;6\n")
        result = parse_cdc_observations(payload, datetime(2026, 10, 18, 13, 25, tzinfo=timezone.utc))
        self.assertEqual(result["forecast"]["status"], "unavailable")
        self.assertNotIn("windKmh", result["observation"]["values"])
        self.assertIn("windSpeedKmh", result["unavailableParameters"])

    def test_fetch_error_retains_previous_but_marks_error(self):
        previous = {"schemaVersion": 1, "observation": {"measuredAt": "2026-10-18T12:00:00Z"}, "status": "ok"}
        result = mark_error(previous, datetime(2026, 10, 18, 13, 0, tzinfo=timezone.utc), "offline")
        self.assertEqual(result["status"], "error")
        self.assertIn("not current", result["statusReason"])
        self.assertEqual(result["observation"], previous["observation"])

    def test_run_uses_mocked_source_and_writes_only_requested_weather_file(self):
        payload = make_zip("MESS_DATUM;QN;PP_10;TT_10;RF_10;TD_10\n202610181320;3;1000;12;70;6\n")
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "weather-dwd.json"
            with patch("src.dwd_weather.fetch_dwd_zip", return_value=payload):
                result = run(output, now=datetime(2026, 10, 18, 13, 25, tzinfo=timezone.utc))
            self.assertTrue(output.is_file())
            self.assertEqual(json.loads(output.read_text())["status"], "ok")
            self.assertEqual(result["lastAttemptAt"], "2026-10-18T13:25:00Z")


if __name__ == "__main__":
    unittest.main()
