from __future__ import annotations

import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src import waldbrandgefahrenstufe_fetch as wgs


NOW = dt.datetime(2026, 10, 29, 12, 30, tzinfo=dt.timezone.utc)


def page(date="29.10.2026", level=1, row=None):
    row = row or f"<tr><td>Oberspreewald-Lausitz</td><td><div class='circle farbe{level}'>{level}</div></td></tr>"
    return f"""<!doctype html><html><body><p>Daten vom: {date}</p><table>{row}</table>
    <script>Oberspreewald-Lausitz 5</script></body></html>"""


class Response:
    status = 200
    headers = {"Content-Type": "text/html; charset=utf-8"}

    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, limit):
        return self.body


class WaldbrandFetchTests(unittest.TestCase):
    def test_parses_current_mleuv_adjacent_table_cells(self):
        source_date, level = wgs.parse_source(page())
        self.assertEqual(source_date, dt.date(2026, 10, 29))
        self.assertEqual(level, 1)

    def test_parses_all_documented_levels_one_to_five(self):
        for level in range(1, 6):
            with self.subTest(level=level):
                self.assertEqual(wgs.parse_source(page(level=level))[1], level)

    def test_ignores_script_text_and_reads_only_visible_row(self):
        self.assertEqual(wgs.parse_source(page(level=2))[1], 2)

    def test_accepts_visible_legacy_pipe_separator(self):
        row = "<tr><td>Oberspreewald-Lausitz | 3</td></tr>"
        self.assertEqual(wgs.parse_source(page(level=3, row=row))[1], 3)

    def test_missing_date_is_rejected(self):
        with self.assertRaisesRegex(wgs.SourceError, "Veröffentlichungsdatum"):
            wgs.parse_source(page(date=""))

    def test_ambiguous_date_is_rejected(self):
        html = page().replace("</body>", "<p>Daten vom: 28.10.2026</p></body>")
        with self.assertRaisesRegex(wgs.SourceError, "eindeutiges Veröffentlichungsdatum"):
            wgs.parse_source(html)

    def test_missing_or_invalid_osL_level_is_rejected(self):
        with self.assertRaisesRegex(wgs.SourceError, "keine eindeutige OSL-Stufe"):
            wgs.parse_source(page(row="<tr><td>Oberspreewald-Lausitz</td><td>keine Angabe</td></tr>"))

    def test_ambiguous_osl_rows_are_rejected(self):
        row = "<tr><td>Oberspreewald-Lausitz</td><td>1</td></tr><tr><td>Oberspreewald-Lausitz</td><td>2</td></tr>"
        with self.assertRaisesRegex(wgs.SourceError, "keine eindeutige OSL-Stufe"):
            wgs.parse_source(page(row=row))

    def test_incomplete_html_is_rejected(self):
        with self.assertRaisesRegex(wgs.SourceError, "vollständiges HTML"):
            wgs.parse_source("<html><body><p>Daten vom: 29.10.2026</p>")

    def test_accepts_official_document_with_optional_html_end_tag_omitted(self):
        html = page().replace("</html>", "")
        self.assertEqual(wgs.parse_source(html), (dt.date(2026, 10, 29), 1))

    def test_future_source_date_is_rejected_without_publication(self):
        with self.assertRaisesRegex(wgs.SourceError, "Zukunft"):
            wgs._snapshot(dt.date(2026, 10, 30), 1, NOW)

    def test_successful_old_source_date_is_stale_not_current(self):
        feed = wgs._snapshot(dt.date(2026, 10, 28), 2, NOW)
        self.assertEqual(feed["status"], "stale")
        self.assertEqual(feed["sourceDate"], "2026-10-28")
        self.assertEqual(feed["fetchStatus"], "success")
        self.assertTrue(wgs.validate_feed(feed))

    def test_official_validity_boundaries_are_08_to_08_in_berlin(self):
        source_date = dt.date(2026, 10, 29)
        cases = [
            (dt.datetime(2026, 10, 29, 22, 59, tzinfo=dt.timezone.utc), "current"),  # 23:59 CEST/CET
            (dt.datetime(2026, 10, 29, 23, 0, tzinfo=dt.timezone.utc), "current"),  # 00:00 Berlin
            (dt.datetime(2026, 10, 30, 6, 59, tzinfo=dt.timezone.utc), "current"),  # 07:59 Berlin
            (dt.datetime(2026, 10, 30, 7, 0, tzinfo=dt.timezone.utc), "stale"),  # 08:00 Berlin
        ]
        for instant, expected in cases:
            with self.subTest(instant=instant):
                self.assertEqual(wgs.source_status(source_date, instant), expected)
        self.assertEqual(wgs.source_status(dt.date(2026, 10, 30), dt.datetime(2026, 10, 30, 7, 0, tzinfo=dt.timezone.utc)), "current")
        self.assertEqual(wgs.source_status(dt.date(2026, 10, 30), dt.datetime(2026, 10, 30, 7, 1, tzinfo=dt.timezone.utc)), "current")

    def test_08_00_interval_respects_summer_and_winter_time_changes(self):
        spring_start, spring_end = wgs.validity_interval(dt.date(2026, 3, 28))
        self.assertEqual(spring_start.isoformat(), "2026-03-28T08:00:00+01:00")
        self.assertEqual(spring_end.isoformat(), "2026-03-29T08:00:00+02:00")
        self.assertEqual((spring_end.astimezone(dt.timezone.utc) - spring_start.astimezone(dt.timezone.utc)).total_seconds(), 23 * 3600)
        fall_start, fall_end = wgs.validity_interval(dt.date(2026, 10, 24))
        self.assertEqual(fall_start.isoformat(), "2026-10-24T08:00:00+02:00")
        self.assertEqual(fall_end.isoformat(), "2026-10-25T08:00:00+01:00")
        self.assertEqual((fall_end.astimezone(dt.timezone.utc) - fall_start.astimezone(dt.timezone.utc)).total_seconds(), 25 * 3600)

    def test_failed_fetch_preserves_last_valid_value_and_product_date(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "latest.json"
            previous = wgs._snapshot(dt.date(2026, 10, 29), 1, NOW)
            target.write_text(json.dumps(previous), encoding="utf-8")

            def fail():
                raise wgs.SourceError("MLEUV-HTTP-Status-503")

            result, failed = wgs.update_feed(target, NOW + dt.timedelta(minutes=2), fetcher=fail)
            self.assertTrue(failed)
            self.assertEqual(result["level"], 1)
            self.assertEqual(result["sourceDate"], "2026-10-29")
            self.assertEqual(result["lastSuccessfulAt"], previous["lastSuccessfulAt"])
            self.assertEqual(result["fetchStatus"], "error")
            self.assertEqual(result["lastError"], "MLEUV-HTTP-Status-503")
            self.assertEqual(result["status"], "current")

    def test_failed_fetch_keeps_previous_snapshot_current_after_midnight(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "latest.json"
            previous = wgs._snapshot(dt.date(2026, 10, 29), 1, NOW)
            target.write_text(json.dumps(previous), encoding="utf-8")
            later = dt.datetime(2026, 10, 30, 0, 5, tzinfo=dt.timezone.utc)
            result, failed = wgs.update_feed(target, later, fetcher=lambda: (_ for _ in ()).throw(wgs.SourceError("timeout")))
            self.assertTrue(failed)
            self.assertEqual(result["status"], "current")
            self.assertEqual(result["sourceDate"], "2026-10-29")
            self.assertIn("bis 30.10.2026 08:00", result["statusReason"])

    def test_failed_fetch_marks_snapshot_stale_at_the_next_morning_cutoff(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "latest.json"
            previous = wgs._snapshot(dt.date(2026, 10, 29), 1, NOW)
            target.write_text(json.dumps(previous), encoding="utf-8")
            cutoff = dt.datetime(2026, 10, 30, 7, 0, tzinfo=dt.timezone.utc)
            result, failed = wgs.update_feed(target, cutoff, fetcher=lambda: (_ for _ in ()).throw(wgs.SourceError("timeout")))
            self.assertTrue(failed)
            self.assertEqual(result["status"], "stale")
            self.assertEqual(result["statusEvaluatedAt"], "2026-10-30T07:00:00Z")
            self.assertIn("ist sie abgelaufen", result["statusReason"])

    def test_failed_fetch_without_valid_snapshot_is_unavailable(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "latest.json"
            result, failed = wgs.update_feed(
                target, NOW, fetcher=lambda: (_ for _ in ()).throw(wgs.SourceError("timeout"))
            )
            self.assertTrue(failed)
            self.assertEqual(result["status"], "unavailable")
            self.assertIsNone(result["level"])
            self.assertIsNone(result["sourceDate"])
            self.assertTrue(wgs.validate_feed(result))

    def test_regressed_product_date_does_not_replace_newer_valid_snapshot(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "latest.json"
            previous = wgs._snapshot(dt.date(2026, 10, 29), 1, NOW)
            target.write_text(json.dumps(previous), encoding="utf-8")
            result, failed = wgs.update_feed(
                target, NOW + dt.timedelta(minutes=1),
                fetcher=lambda: (dt.date(2026, 10, 28), 5),
            )
            self.assertTrue(failed)
            self.assertEqual(result["sourceDate"], "2026-10-29")
            self.assertEqual(result["level"], 1)
            self.assertEqual(result["fetchStatus"], "error")

    def test_http_fetch_checks_status_content_type_and_parses_live_shape(self):
        result = wgs.fetch_source(opener=lambda request, timeout: Response(page().encode()))
        self.assertEqual(result, (dt.date(2026, 10, 29), 1))

    def test_http_fetch_rejects_non_html(self):
        response = Response(page().encode())
        response.headers = {"Content-Type": "application/json"}
        with self.assertRaisesRegex(wgs.SourceError, "Content-Type"):
            wgs.fetch_source(opener=lambda request, timeout: response)

    def test_http_fetch_rejects_non_200_status_with_status_code(self):
        response = Response(page().encode())
        response.status = 503
        with self.assertRaisesRegex(wgs.SourceError, "MLEUV-HTTP-Status-503"):
            wgs.fetch_source(opener=lambda request, timeout: response)

    def test_http_error_is_reported_without_response_body(self):
        def fail(request, timeout):
            raise wgs.urllib.error.HTTPError(wgs.SOURCE_URL, 503, "Service unavailable", {}, None)

        with self.assertRaisesRegex(wgs.SourceError, "MLEUV-HTTP-Status-503"):
            wgs.fetch_source(opener=fail)

    def test_http_fetch_rejects_oversized_response(self):
        response = Response(b"x" * (wgs.MAX_RESPONSE_BYTES + 1))
        with self.assertRaisesRegex(wgs.SourceError, "Größenlimit"):
            wgs.fetch_source(opener=lambda request, timeout: response)

    def test_source_only_does_not_write_output_file(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "must-not-exist.json"
            class FrozenDateTime(dt.datetime):
                @classmethod
                def now(cls, tz=None):
                    return NOW.astimezone(tz) if tz else NOW.replace(tzinfo=None)

            with patch.object(wgs, "fetch_source", return_value=(dt.date(2026, 10, 29), 1)), patch.object(wgs.dt, "datetime", FrozenDateTime):
                result = wgs.main(["--source-only", "--output", str(target)])
            self.assertEqual(result, 0)
            self.assertFalse(target.exists())

    def test_status_snapshot_is_consistent_with_its_evaluation_instant(self):
        feed = wgs._snapshot(dt.date(2026, 10, 29), 1, dt.datetime(2026, 10, 29, 23, 30, tzinfo=dt.timezone.utc))
        self.assertEqual(feed["status"], "current")
        self.assertEqual(feed["statusEvaluatedAt"], "2026-10-29T23:30:00Z")
        self.assertIn("bis 30.10.2026 08:00", feed["statusReason"])
        self.assertTrue(wgs.validate_feed(feed))

    def test_atomic_output_contract_validates(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "nested" / "feed.json"
            feed = wgs._snapshot(dt.date(2026, 10, 29), 4, NOW)
            wgs.atomic_write(target, feed)
            self.assertTrue(wgs.validate_feed(json.loads(target.read_text(encoding="utf-8"))))

    def test_public_snapshot_is_valid_and_does_not_fabricate_missing_values(self):
        target = Path(__file__).resolve().parents[1] / "data/generated/waldbrandgefahrenstufe-osl.json"
        feed = json.loads(target.read_text(encoding="utf-8"))
        self.assertTrue(wgs.validate_feed(feed))
        if feed["sourceDate"] is None:
            self.assertEqual(feed["status"], "unavailable")
            self.assertIsNone(feed["level"])
        else:
            self.assertIn(feed["level"], range(1, 6))
            self.assertTrue(wgs._is_iso_date(feed["sourceDate"]))

    def test_workflow_is_daily_manual_and_uses_isolated_guarded_publication(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/update-waldbrandgefahrenstufe-osl.yml").read_text()
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("cron: '20 7 * * *'", workflow)
        self.assertIn("group: lhh-data-hub-waldbrandgefahrenstufe-osl", workflow)
        self.assertIn("bash scripts/publish_one_snapshot.sh", workflow)
        self.assertIn("data/generated/waldbrandgefahrenstufe-osl.json", workflow)
        self.assertIn("WORKFLOW_FILE: update-waldbrandgefahrenstufe-osl.yml", workflow)
        self.assertNotIn("AZURE_", workflow)
        self.assertNotIn("sharepoint", workflow.lower())


if __name__ == "__main__":
    unittest.main()
