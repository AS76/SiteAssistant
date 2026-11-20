CREATE TABLE IF NOT EXISTS view_settings (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  module TEXT NOT NULL CHECK (module IN ('tasks', 'deviations', 'progress', 'bookings', 'impacts', 'wbs')),
  name TEXT NOT NULL,
  owner_id UUID NOT NULL REFERENCES users(id),
  shared BOOLEAN NOT NULL DEFAULT FALSE,
  payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (site_id, module, owner_id, name)
);
CREATE INDEX IF NOT EXISTS view_settings_site_module ON view_settings(site_id, module);
