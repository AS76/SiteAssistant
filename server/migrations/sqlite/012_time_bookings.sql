CREATE TABLE IF NOT EXISTS time_bookings (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  work_day_id TEXT NOT NULL REFERENCES work_days(id),
  site_progress_item_id TEXT NOT NULL REFERENCES site_progress_items(id),
  hours NUMERIC NOT NULL CHECK (hours >= 0),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (work_day_id, site_progress_item_id)
);
CREATE INDEX IF NOT EXISTS time_bookings_item ON time_bookings(site_progress_item_id);
CREATE INDEX IF NOT EXISTS time_bookings_site ON time_bookings(site_id);
