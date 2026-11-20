CREATE TABLE attachments_with_hse_event (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('task', 'diary', 'site', 'hse_event')),
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
INSERT INTO attachments_with_hse_event
  (id, site_id, entity_type, entity_id, filename, mime, size, content_sha256,
   storage_locator, manifest_version, uploaded_by, created_at)
  SELECT id, site_id, entity_type, entity_id, filename, mime, size, content_sha256,
    storage_locator, manifest_version, uploaded_by, created_at FROM attachments;
DROP TABLE attachments;
ALTER TABLE attachments_with_hse_event RENAME TO attachments;
CREATE INDEX attachments_entity ON attachments (site_id, entity_type, entity_id);
