import unittest
from datetime import datetime, time, timezone

from scripts.check_schedule_lateness import evaluate, latest_cron_slot, latest_daily_slot, parse_utc


class ScheduleLatenessTests(unittest.TestCase):
    def test_quarter_hour_schedule_uses_latest_expected_slot(self):
        started = parse_utc("2026-10-29T12:04:00Z")
        expected = latest_cron_slot(started, [3, 18, 33, 48])
        self.assertEqual(expected.isoformat(), "2026-10-29T12:03:00+00:00")
        delay, ok = evaluate(started, expected, 5)
        self.assertEqual(delay, 1)
        self.assertTrue(ok)

    def test_late_schedule_is_reported_as_failure(self):
        started = parse_utc("2026-10-29T12:10:00Z")
        expected = latest_cron_slot(started, [3, 18, 33, 48])
        delay, ok = evaluate(started, expected, 5)
        self.assertEqual(delay, 7)
        self.assertFalse(ok)

    def test_daily_schedule_crosses_midnight_correctly(self):
        started = parse_utc("2026-10-30T05:44:00Z")
        expected = latest_daily_slot(started, time(5, 15, tzinfo=timezone.utc))
        self.assertEqual(expected.isoformat(), "2026-10-30T05:15:00+00:00")
        self.assertTrue(evaluate(started, expected, 30)[1])

    def test_daily_schedule_before_today_slot_uses_previous_day(self):
        started = parse_utc("2026-10-30T05:10:00Z")
        expected = latest_daily_slot(started, time(5, 15, tzinfo=timezone.utc))
        self.assertEqual(expected.isoformat(), "2026-10-29T05:15:00+00:00")

    def test_timezone_required(self):
        with self.assertRaises(ValueError):
            parse_utc("2026-10-29T12:04:00")


if __name__ == "__main__":
    unittest.main()
