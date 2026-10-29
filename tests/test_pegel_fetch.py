import sys
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from pegel_fetch import STATIONS, SourceError, fetch_station, parse_csv, run, error_from_previous

NOW = datetime(2026, 10, 18, 16, 4, tzinfo=timezone.utc)
LAUCHHAMMER = STATIONS[0]
BIEHLEN = STATIONS[1]

def csv_for(station, rows):
    header = f'Datum;"Wasserstand in cm";"Stationsnummer: {station["stationNumber"]}";"Stationsname: {station["name"]}";"Gewässer: Schwarze Elster";"Fehlwerte: -777"'
    return (header + "\n" + "\n".join(f'"{ts}";{value}' for ts, value in rows) + "\n").encode("cp1252")

class ParseTests(unittest.TestCase):
    def test_parses_portal_csv_and_timezone(self):
        data = parse_csv(csv_for(LAUCHHAMMER, [("18.10.2026 18:00", "59")]), LAUCHHAMMER, NOW)
        self.assertEqual(data["latestMeasurement"]["waterLevelCm"], 59)
        self.assertEqual(data["latestMeasurement"]["measuredAt"], "2026-10-18T18:00:00+02:00")
        self.assertEqual(data["latestMeasurement"]["measuredAtUtc"], "2026-10-18T16:00:00Z")
        self.assertEqual(data["retrievedAt"], "2026-10-18T16:04:00Z")
        self.assertEqual(data["ageMinutes"], 4)
        self.assertEqual(data["status"], "ok")
        self.assertNotIn("current", data)

    def test_selects_latest_valid_independent_of_csv_order_and_skips_sentinel(self):
        payload = csv_for(LAUCHHAMMER, [("18.10.2026 16:00", "58"), ("18.10.2026 16:45", "-777"), ("18.10.2026 15:45", "57")])
        data = parse_csv(payload, LAUCHHAMMER, NOW)
        self.assertEqual(data["latestMeasurement"]["waterLevelCm"], 58)
        self.assertEqual(data["invalidRowsSkipped"], 1)

    def test_stale_data_marked(self):
        data = parse_csv(csv_for(LAUCHHAMMER, [("18.10.2026 16:00", "58")]), LAUCHHAMMER, NOW)
        self.assertEqual(data["status"], "stale")
        self.assertGreater(data["ageMinutes"], 45)

    def test_mismatched_station_rejected(self):
        with self.assertRaises(SourceError):
            parse_csv(csv_for(BIEHLEN, [("18.10.2026 18:00", "41")]), LAUCHHAMMER, NOW)

    def test_invalid_only_rows_rejected(self):
        with self.assertRaises(SourceError):
            parse_csv(csv_for(BIEHLEN, [("18.10.2026 18:00", "-777"), ("bad", "42")]), BIEHLEN, NOW)

    def test_dst_ambiguous_timestamp_rejected(self):
        with self.assertRaises(SourceError):
            parse_csv(csv_for(BIEHLEN, [("25.10.2026 02:15", "41")]), BIEHLEN, NOW)

    def test_dst_nonexistent_timestamp_rejected(self):
        with self.assertRaises(SourceError):
            parse_csv(csv_for(BIEHLEN, [("29.03.2026 02:30", "41")]), BIEHLEN, NOW)

    def test_winter_uses_cet_offset(self):
        winter = datetime(2026, 1, 18, 11, 0, tzinfo=timezone.utc)
        data = parse_csv(csv_for(BIEHLEN, [("18.01.2026 12:00", "41")]), BIEHLEN, winter)
        self.assertEqual(data["latestMeasurement"]["measuredAt"], "2026-01-18T12:00:00+01:00")
        self.assertEqual(data["latestMeasurement"]["measuredAtUtc"], "2026-01-18T11:00:00Z")
        self.assertEqual(data["status"], "ok")

    def test_naive_reference_time_rejected(self):
        with self.assertRaises(ValueError):
            parse_csv(csv_for(BIEHLEN, [("18.10.2026 18:00", "41")]), BIEHLEN, datetime(2026, 10, 18, 16, 0))

    def test_future_measurement_rejected(self):
        future = datetime(2026, 10, 18, 16, 0, tzinfo=timezone.utc)
        with self.assertRaises(SourceError):
            parse_csv(csv_for(BIEHLEN, [("18.10.2026 19:00", "41")]), BIEHLEN, future)

    def test_successful_old_measurement_is_stale_not_error(self):
        data = parse_csv(csv_for(LAUCHHAMMER, [("18.10.2026 14:00", "58")]), LAUCHHAMMER, NOW)
        self.assertEqual(data["status"], "stale")
        self.assertGreater(data["ageMinutes"], 45)
        self.assertEqual(data["latestMeasurement"]["waterLevelCm"], 58)

    def test_measurement_at_exact_freshness_limit_is_ok(self):
        data = parse_csv(csv_for(LAUCHHAMMER, [("18.10.2026 17:19", "58")]), LAUCHHAMMER, NOW)
        self.assertEqual(data["ageMinutes"], 45)
        self.assertEqual(data["status"], "ok")

    def test_technical_failure_preserves_previous_value_but_marks_error(self):
        previous = {"stationNumber": BIEHLEN["stationNumber"], "current": {"waterLevelCm": 41, "measuredAt": "2026-10-18T16:00:00+02:00", "measuredAtUtc": "2026-10-18T14:00:00Z"}, "history": [], "retrievedAt": "2026-10-18T14:01:00Z"}
        data = error_from_previous(BIEHLEN, previous, NOW, "timeout")
        self.assertEqual(data["status"], "error")
        self.assertEqual(data["latestMeasurement"]["waterLevelCm"], 41)
        self.assertEqual(data["ageMinutes"], 124)
        self.assertEqual(data["retrievedAt"], "2026-10-18T14:01:00Z")
        self.assertEqual(data["lastAttemptAt"], "2026-10-18T16:04:00Z")
        self.assertEqual(data["lastError"], "timeout")
        self.assertNotIn("current", data)

    def test_failure_without_previous_is_error_without_measurement(self):
        data = error_from_previous(BIEHLEN, None, NOW, "connection refused")
        self.assertEqual(data["status"], "error")
        self.assertIsNone(data["latestMeasurement"])
        self.assertIsNone(data["retrievedAt"])
        self.assertIsNone(data["ageMinutes"])

    def test_failure_does_not_reuse_wrong_station_previous_json(self):
        previous = {"stationNumber": LAUCHHAMMER["stationNumber"], "current": {"waterLevelCm": 58, "measuredAtUtc": "2026-10-18T14:00:00Z"}}
        data = error_from_previous(BIEHLEN, previous, NOW, "timeout")
        self.assertEqual(data["status"], "error")
        self.assertIsNone(data["latestMeasurement"])

    def test_http_timeout_is_reported_as_source_error(self):
        with patch("pegel_fetch.urllib.request.urlopen", side_effect=TimeoutError("timed out")):
            with self.assertRaises(SourceError):
                fetch_station(LAUCHHAMMER, timeout=0.01)

    def test_no_alarm_level_inferred(self):
        data = parse_csv(csv_for(BIEHLEN, [("18.10.2026 18:00", "41")]), BIEHLEN, NOW)
        self.assertIsNone(data["officialAlarmLevel"])

    def test_both_station_mappings_are_validated(self):
        for station, value in ((LAUCHHAMMER, "59"), (BIEHLEN, "41")):
            with self.subTest(station=station["stationNumber"]):
                data = parse_csv(csv_for(station, [("18.10.2026 18:00", value)]), station, NOW)
                self.assertEqual(data["stationNumber"], station["stationNumber"])
                self.assertEqual(data["status"], "ok")

    def test_run_keeps_station_failures_isolated_and_writes_both_json_files(self):
        valid = csv_for(LAUCHHAMMER, [("18.10.2026 18:00", "59")])
        with tempfile.TemporaryDirectory() as tmp:
            with patch("pegel_fetch.fetch_station", side_effect=[valid, TimeoutError("portal timeout")]):
                results = run(Path(tmp), NOW)
            self.assertEqual([r["status"] for r in results], ["ok", "error"])
            self.assertEqual(json.loads((Path(tmp) / "pegel-lauchhammer.json").read_text())["latestMeasurement"]["waterLevelCm"], 59)
            self.assertIsNone(json.loads((Path(tmp) / "pegel-biehlen-1.json").read_text())["latestMeasurement"])

    def test_run_preserves_previous_value_as_error_after_failed_fetch(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pegel-lauchhammer.json"
            previous = {"stationNumber": LAUCHHAMMER["stationNumber"], "current": {"waterLevelCm": 58, "measuredAtUtc": "2026-10-18T14:00:00Z"}, "retrievedAt": "2026-10-18T14:02:00Z"}
            path.write_text(json.dumps(previous), encoding="utf-8")
            with patch("pegel_fetch.fetch_station", side_effect=TimeoutError("portal timeout")):
                result = run(Path(tmp), NOW)[0]
            self.assertEqual(result["status"], "error")
            self.assertEqual(result["latestMeasurement"]["waterLevelCm"], 58)
            self.assertEqual(result["retrievedAt"], "2026-10-18T14:02:00Z")
            self.assertEqual(result["lastAttemptAt"], "2026-10-18T16:04:00Z")
            self.assertEqual(json.loads(path.read_text())["status"], "error")

    def test_generated_json_is_not_ignored(self):
        gitignore = Path(__file__).resolve().parents[1] / ".gitignore"
        patterns = gitignore.read_text().splitlines()
        self.assertNotIn("data/generated/*.json", patterns)

    def test_workflow_adds_both_outputs_and_only_fails_on_technical_error(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/update-levels.yml").read_text()
        self.assertIn("contents: write", workflow)
        self.assertIn("bash scripts/publish_one_snapshot.sh", workflow)
        self.assertIn("data/generated/pegel-lauchhammer.json", workflow)
        self.assertIn("data/generated/pegel-biehlen-1.json", workflow)
        self.assertIn('cron: "11,26,41,56 * * * *"', workflow)
        self.assertIn('data.get("status") not in ("ok", "stale")', workflow)
        self.assertNotIn('data.get("status") != "ok"', workflow)

if __name__ == "__main__":
    unittest.main()
