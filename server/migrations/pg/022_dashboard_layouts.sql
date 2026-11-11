CREATE TABLE IF NOT EXISTS dashboard_layouts (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  owner_id UUID NOT NULL REFERENCES users(id),
  widgets_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (site_id, owner_id)
);
