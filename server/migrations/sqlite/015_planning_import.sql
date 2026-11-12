-- Application uploads are independent of snapshot ingestion runs and batches.
CREATE TABLE IF NOT EXISTS planning_import_runs (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  family TEXT NOT NULL,
  filename TEXT,
  file_sha256 TEXT,
  file_data BLOB,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  counts_json TEXT,
  applied_keys_json TEXT,
  UNIQUE (site_id, id)
);
CREATE TABLE IF NOT EXISTS planning_import_keys (
  site_id TEXT NOT NULL REFERENCES sites(id),
  family TEXT NOT NULL,
  import_key TEXT NOT NULL,
  target_id TEXT NOT NULL,
  identity_state TEXT NOT NULL CHECK (identity_state IN ('observed', 'unresolved')),
  last_import_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, family, import_key),
  UNIQUE (site_id, family, target_id),
  FOREIGN KEY (site_id, last_import_run_id) REFERENCES planning_import_runs(site_id, id)
);
CREATE INDEX IF NOT EXISTS planning_import_runs_site ON planning_import_runs(site_id, created_at);
