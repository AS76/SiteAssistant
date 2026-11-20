CREATE TABLE IF NOT EXISTS import_mappings (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  family TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '{}',
  identity_json TEXT NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (site_id, family)
);
