-- Application projection only; ingestion schemas are provisioned separately.
CREATE TABLE IF NOT EXISTS site_progress_items (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  wbs_id TEXT REFERENCES project_structure(id),
  description TEXT,
  plc_area TEXT,
  section TEXT,
  progress_pct NUMERIC,
  planned_progress_pct NUMERIC,
  delta_progress_source NUMERIC,
  assigned_to TEXT,
  planned_start TEXT,
  planned_finish TEXT,
  actual_start TEXT,
  expected_delay TEXT,
  has_files BOOLEAN,
  has_notes BOOLEAN,
  has_deviations BOOLEAN,
  source_row INTEGER NOT NULL,
  source_entity_key_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (site_id, source_row)
);
CREATE INDEX IF NOT EXISTS site_progress_items_site_wbs ON site_progress_items(site_id, wbs_id);

-- Trusted site/scope/run binding, never inferred from site names or accepted over HTTP.
CREATE TABLE IF NOT EXISTS site_progress_import_sources (
  site_id TEXT PRIMARY KEY NOT NULL REFERENCES sites(id),
  scope_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  promoted_run_id TEXT,
  promoted_batch_id TEXT,
  promoted_at TEXT
);
