-- Application projection only; ingestion schemas are provisioned separately.
CREATE TABLE IF NOT EXISTS site_progress_items (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  wbs_id UUID REFERENCES project_structure(id),
  description TEXT,
  plc_area TEXT,
  section TEXT,
  progress_pct NUMERIC,
  planned_progress_pct NUMERIC,
  delta_progress_source NUMERIC,
  assigned_to TEXT,
  planned_start TIMESTAMPTZ,
  planned_finish TIMESTAMPTZ,
  actual_start TIMESTAMPTZ,
  expected_delay TEXT,
  has_files BOOLEAN,
  has_notes BOOLEAN,
  has_deviations BOOLEAN,
  source_row INTEGER NOT NULL,
  source_entity_key_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (site_id, source_row)
);
CREATE INDEX IF NOT EXISTS site_progress_items_site_wbs ON site_progress_items(site_id, wbs_id);

-- Trusted site/scope/run binding, never inferred from site names or accepted over HTTP.
CREATE TABLE IF NOT EXISTS site_progress_import_sources (
  site_id UUID PRIMARY KEY NOT NULL REFERENCES sites(id),
  scope_id UUID NOT NULL,
  run_id UUID NOT NULL,
  promoted_run_id UUID,
  promoted_batch_id UUID,
  promoted_at TIMESTAMPTZ
);
