CREATE TABLE IF NOT EXISTS hse_events (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  event_no TEXT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  occurred_on DATE NOT NULL,
  location TEXT,
  persons_involved INTEGER,
  measures TEXT,
  notes TEXT,
  deviation_id TEXT REFERENCES deviations(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, event_no)
);
CREATE INDEX IF NOT EXISTS hse_events_site_occurred ON hse_events(site_id, occurred_on);
CREATE INDEX IF NOT EXISTS hse_events_site_type ON hse_events(site_id, type);
