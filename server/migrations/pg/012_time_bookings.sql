CREATE TABLE IF NOT EXISTS time_bookings (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  work_day_id UUID NOT NULL REFERENCES work_days(id),
  site_progress_item_id UUID NOT NULL REFERENCES site_progress_items(id),
  hours NUMERIC NOT NULL CHECK (hours >= 0),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (work_day_id, site_progress_item_id)
);
CREATE INDEX IF NOT EXISTS time_bookings_item ON time_bookings(site_progress_item_id);
CREATE INDEX IF NOT EXISTS time_bookings_site ON time_bookings(site_id);
