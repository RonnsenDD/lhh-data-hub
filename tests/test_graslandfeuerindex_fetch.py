import gzip
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from graslandfeuerindex_fetch import (STATION_ID, STATION_NAME, SOURCE_URL, SourceError, build_feed,
    parse_forecast_csv, update_feed, validate_feed)

NOW = datetime(2026, 10, 27, 6, 0, tzinfo=timezone.utc)

def csv_fixture(termin="20261027 12:00", station=STATION_ID, values="1;2;3;4;5;4;3"):
    return ("StationsID;Termin;glfi_0;glfi_1;glfi_2;glfi_3;glfi_4;glfi_5;glfi_6\n" +
            "%s;%s;%s\n" % (station, termin, values)).encode("utf-8")

class GrasslandFeedTests(unittest.TestCase):
    def test_success_maps_station_dates_and_valid_values(self):
        feed = build_feed(csv_fixture(), NOW, "Tue, 27 Oct 2026 05:05:00 GMT")
        self.assertEqual(feed["station"], {"name": STATION_NAME, "id": STATION_ID})
        self.assertEqual(feed["today"], {"date": "2026-10-27", "index": 1})
        self.assertEqual([day["index"] for day in feed["days"]], [1,2,3,4,5,4,3])
        self.assertEqual(feed["status"], "ok")
        self.assertTrue(validate_feed(feed))
        self.assertEqual(feed["source"]["url"], SOURCE_URL)
        self.assertEqual(feed["source"]["license"], "CC BY 4.0")
        self.assertEqual(feed["lastSuccessfulAt"], "2026-10-27T06:00:00.000Z")

    def test_no_today_forecast_is_stale_not_fabricated(self):
        feed = build_feed(csv_fixture(termin="20261028 12:00"), NOW, "Tue, 27 Oct 2026 05:05:00 GMT")
        self.assertEqual(feed["status"], "stale")
        self.assertIsNone(feed["today"])

    def test_old_source_marked_stale(self):
        feed = build_feed(csv_fixture(), NOW, "Sun, 25 Oct 2026 05:05:00 GMT")
        self.assertEqual(feed["status"], "stale")
        self.assertEqual(feed["today"]["date"], "2026-10-27")

    def test_missing_station_rejected(self):
        with self.assertRaises(ValueError):
            parse_forecast_csv(csv_fixture(station="0000"))

    def test_missing_values_rejected(self):
        with self.assertRaises(ValueError):
            parse_forecast_csv(b"StationsID;Termin;glfi_0;glfi_1;glfi_2;glfi_3;glfi_4;glfi_5;glfi_6\n")

    def test_invalid_index_rejected(self):
        with self.assertRaises(ValueError):
            parse_forecast_csv(csv_fixture(values="1;2;3;4;5;0;3"))

    def test_unclassified_failure_writes_error_or_stale_without_claiming_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "feed.json"
            feed, failed = update_feed(path, NOW, fetcher=lambda: (_ for _ in ()).throw(Exception("HTTP 503")))
            self.assertTrue(failed)
            self.assertEqual(feed["status"], "error")
            self.assertIsNone(feed["lastSuccessfulAt"])
            self.assertEqual(feed["days"], [])
            saved = json.loads(path.read_text())
            self.assertEqual(saved["status"], "error")

    def test_parser_failure_preserves_old_values_explicitly_stale(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "feed.json"
            previous = build_feed(csv_fixture(), NOW, "Tue, 27 Oct 2026 05:05:00 GMT")
            path.write_text(json.dumps(previous))
            later = datetime(2026, 10, 27, 6, 5, tzinfo=timezone.utc)
            feed, failed = update_feed(path, later, fetcher=lambda: (b"invalid csv", None))
            self.assertTrue(failed)
            self.assertEqual(feed["status"], "stale")
            self.assertEqual(feed["days"], previous["days"])
            self.assertEqual(feed["lastSuccessfulAt"], previous["lastSuccessfulAt"])
            self.assertNotEqual(feed["lastAttemptAt"], feed["lastSuccessfulAt"])
            self.assertIn("DWD-CSV", feed.get("lastError", ""))

    def test_http_error_classification(self):
        from urllib.error import HTTPError
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "feed.json"
            feed, failed = update_feed(path, NOW, fetcher=lambda: (_ for _ in ()).throw(SourceError("DWD-HTTP-Status-503")))
            self.assertTrue(failed)
            self.assertEqual(feed["lastError"], "DWD-HTTP-Status-503")

    def test_http_failure_preserves_previous_forecast_as_stale(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "feed.json"
            previous = build_feed(csv_fixture(), NOW, "Tue, 27 Oct 2026 05:05:00 GMT")
            path.write_text(json.dumps(previous), encoding="utf-8")
            later = datetime(2026, 10, 27, 6, 5, tzinfo=timezone.utc)
            feed, failed = update_feed(path, later, fetcher=lambda: (_ for _ in ()).throw(SourceError("DWD-HTTP-Status-503")))
            self.assertTrue(failed)
            self.assertEqual(feed["status"], "stale")
            self.assertEqual(feed["days"], previous["days"])
            self.assertEqual(feed["lastSuccessfulAt"], previous["lastSuccessfulAt"])
            self.assertEqual(feed["lastError"], "DWD-HTTP-Status-503")

    def test_gzip_fixture_is_readable(self):
        self.assertEqual(gzip.decompress(gzip.compress(csv_fixture())), csv_fixture())

    def test_http_status_failure_uses_source_error(self):
        from urllib.error import HTTPError
        from unittest.mock import patch
        from graslandfeuerindex_fetch import fetch_source
        with patch("urllib.request.urlopen", side_effect=HTTPError(SOURCE_URL, 503, "unavailable", {}, None)):
            with self.assertRaisesRegex(SourceError, "DWD-HTTP-Status-503"):
                fetch_source()

    def test_successful_http_fetch_decompresses_and_checks_the_dwd_endpoint(self):
        from unittest.mock import patch
        from graslandfeuerindex_fetch import fetch_source
        class Response:
            status = 200
            headers = {"Last-Modified": "Tue, 27 Oct 2026 05:05:00 GMT"}
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return False
            def read(self, limit):
                payload = gzip.compress(csv_fixture())
                self.asserted_limit = limit
                return payload
        response = Response()
        with patch("urllib.request.urlopen", return_value=response) as opener:
            payload, last_modified = fetch_source()
        self.assertEqual(payload, csv_fixture())
        self.assertEqual(last_modified, response.headers["Last-Modified"])
        self.assertEqual(opener.call_args.args[0].full_url, SOURCE_URL)

    def test_workflow_output_is_atomic_json_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "data" / "graslandfeuerindex.json"
            feed, failed = update_feed(path, NOW, fetcher=lambda: (csv_fixture(), "Tue, 27 Oct 2026 05:05:00 GMT"))
            self.assertFalse(failed)
            self.assertTrue(validate_feed(json.loads(path.read_text(encoding="utf-8"))))
            self.assertEqual(feed["status"], "ok")

if __name__ == "__main__":
    unittest.main()
