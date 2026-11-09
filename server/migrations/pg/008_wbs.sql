-- Application projection only; ingestion schemas and source mappings are provisioned separately.
CREATE TABLE IF NOT EXISTS project_structure (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  parent_id UUID REFERENCES project_structure(id),
  source_uuid UUID,
  wbs_code TEXT NOT NULL,
  description TEXT,
  level INTEGER NOT NULL CHECK (level >= 0),
  sort_order INTEGER,
  summary_task BOOLEAN,
  progress_pct NUMERIC,
  planned_start TIMESTAMPTZ, planned_finish TIMESTAMPTZ,
  actual_start TIMESTAMPTZ, actual_finish TIMESTAMPTZ,
  planned_hours NUMERIC,
  section TEXT, plc_area TEXT, assigned_to TEXT,
  is_synthetic BOOLEAN NOT NULL DEFAULT FALSE,
  source_entity_key_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id),
  UNIQUE (site_id, source_uuid)
);
CREATE INDEX IF NOT EXISTS project_structure_parent ON project_structure(site_id, parent_id);
CREATE INDEX IF NOT EXISTS project_structure_order ON project_structure(site_id, level, sort_order);

-- Explicit trusted configuration: never infer a source scope from a site name/code.
-- No FK into optional ingestion schemas (SQLite can attach those separately).
CREATE TABLE IF NOT EXISTS wbs_import_sources (
  site_id UUID PRIMARY KEY NOT NULL REFERENCES sites(id),
  scope_id UUID NOT NULL,
  run_id UUID NOT NULL,
  promoted_run_id UUID,
  promoted_batch_id UUID,
  promoted_at TIMESTAMPTZ
);
