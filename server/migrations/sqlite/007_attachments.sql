CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('task', 'diary', 'site')),
  entity_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  storage_locator TEXT NOT NULL,
  manifest_version TEXT NOT NULL DEFAULT 'v1',
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_entity ON attachments (site_id, entity_type, entity_id);
