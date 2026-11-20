-- Application projection only; ingestion schemas and source mappings are provisioned separately.
CREATE TABLE IF NOT EXISTS project_structure (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  parent_id TEXT REFERENCES project_structure(id),
  source_uuid TEXT,
  wbs_code TEXT NOT NULL,
  description TEXT,
  level INTEGER NOT NULL CHECK (level >= 0),
  sort_order INTEGER,
  summary_task BOOLEAN,
  progress_pct NUMERIC,
  planned_start TEXT, planned_finish TEXT,
  actual_start TEXT, actual_finish TEXT,
  planned_hours NUMERIC,
  section TEXT, plc_area TEXT, assigned_to TEXT,
  is_synthetic BOOLEAN NOT NULL DEFAULT FALSE,
  source_entity_key_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id),
  UNIQUE (site_id, source_uuid)
);
CREATE INDEX IF NOT EXISTS project_structure_parent ON project_structure(site_id, parent_id);
CREATE INDEX IF NOT EXISTS project_structure_order ON project_structure(site_id, level, sort_order);

-- Explicit trusted configuration: never infer a source scope from a site name/code.
-- No FK into optional ingestion schemas (SQLite can attach those separately).
CREATE TABLE IF NOT EXISTS wbs_import_sources (
  site_id TEXT PRIMARY KEY NOT NULL REFERENCES sites(id),
  scope_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  promoted_run_id TEXT,
  promoted_batch_id TEXT,
  promoted_at TEXT
);
