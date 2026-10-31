from pathlib import Path
import sqlite3
import unittest


ROOT = Path(__file__).parent
WORKER = ROOT / "worker.mjs"
SCHEMA = ROOT / "migrations" / "0001_init.sql"


class DispatchGuardSqlTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(SCHEMA.read_text(encoding="utf-8"))
        source = WORKER.read_text(encoding="utf-8")
        marker = "export const CLAIM_DISPATCH_SQL = " + chr(96)
        start = source.index(marker) + len(marker)
        end = source.index(chr(96) + ";", start)
        self.sql = source[start:end]

    def tearDown(self):
        self.db.close()

    def claim(self, key, now_ms, cooldown_minutes, max_per_day):
        from datetime import datetime, timezone
        day = datetime.fromtimestamp(now_ms / 1000, timezone.utc).strftime("%Y-%m-%d")
        return self.db.execute(self.sql, (
            key,
            now_ms + cooldown_minutes * 60_000,
            now_ms,
            day,
            now_ms,
            now_ms - cooldown_minutes * 60_000,
            day,
            max_per_day,
        )).fetchall()

    def test_first_claim_is_exclusive_and_cooldown_is_enforced(self):
        now = 1793420400000
        self.assertEqual(len(self.claim("weather", now, 60, 3)), 1)
        self.assertEqual(len(self.claim("weather", now, 60, 3)), 0)
        self.assertEqual(len(self.claim("weather", now + 59 * 60_000, 60, 3)), 0)
        self.assertEqual(len(self.claim("weather", now + 61 * 60_000, 60, 3)), 1)

    def test_daily_cap_resets_only_at_utc_day_boundary(self):
        now = 1793420400000
        self.assertEqual(len(self.claim("wildfire", now, 360, 1)), 1)
        self.assertEqual(len(self.claim("wildfire", now + 7 * 3600_000, 360, 1)), 0)
        next_day = ((now // 86_400_000) + 1) * 86_400_000 + 60_000
        self.assertEqual(len(self.claim("wildfire", next_day, 360, 1)), 1)


if __name__ == "__main__":
    unittest.main()
