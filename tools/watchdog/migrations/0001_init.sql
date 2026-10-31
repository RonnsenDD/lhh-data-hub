CREATE TABLE IF NOT EXISTS watchdog_status (
  source_key TEXT PRIMARY KEY,
  workflow_key TEXT NOT NULL,
  checked_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('aktuell', 'veraltet', 'Abruf fehlgeschlagen', 'Automatik ausgefallen')),
  detail_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watchdog_status_checked_at
  ON watchdog_status (checked_at_ms);

CREATE TABLE IF NOT EXISTS dispatch_guard (
  workflow_key TEXT PRIMARY KEY,
  lease_until_ms INTEGER NOT NULL,
  last_dispatch_at_ms INTEGER NOT NULL,
  dispatch_day_utc TEXT NOT NULL,
  dispatch_count INTEGER NOT NULL CHECK (dispatch_count >= 1)
);

CREATE TABLE IF NOT EXISTS watchdog_control (
  key TEXT PRIMARY KEY,
  until_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watchdog_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at_ms INTEGER NOT NULL,
  workflow_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watchdog_events_created_at
  ON watchdog_events (created_at_ms);
