CREATE TABLE IF NOT EXISTS import_mappings (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  family TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '{}',
  identity_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, family)
);
