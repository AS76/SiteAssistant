CREATE TABLE IF NOT EXISTS dashboard_layouts (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  widgets_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, owner_id)
);
