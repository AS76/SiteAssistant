-- Read-only application projection; ingestion schemas are provisioned separately.
CREATE TABLE IF NOT EXISTS deviations (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  deviation_no TEXT, title TEXT, problem_description TEXT,
  status TEXT CHECK (status IN ('open', 'approved', 'in_progress', 'work_completed', 'closed', 'rejected')),
  priority TEXT, author TEXT, assigned_to TEXT, plc_area TEXT,
  creation_date TIMESTAMPTZ, due_date TIMESTAMPTZ, approved_date TIMESTAMPTZ, closed_date TIMESTAMPTZ,
  actual_cost NUMERIC, claim_quantity NUMERIC, labor_hours NUMERIC, completed_tasks_pct NUMERIC,
  source_entity_key_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (site_id, deviation_no)
);
CREATE INDEX IF NOT EXISTS deviations_site_status ON deviations(site_id, status);
CREATE INDEX IF NOT EXISTS deviations_site_priority ON deviations(site_id, priority);

-- Polymorphic targets are explicit references; only the deviation has a foreign key.
CREATE TABLE IF NOT EXISTS deviation_links (
  deviation_id UUID NOT NULL REFERENCES deviations(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('site_progress_item', 'work_day', 'task', 'diary')),
  entity_id UUID NOT NULL,
  PRIMARY KEY (deviation_id, entity_type, entity_id)
);

-- Trusted site/scope/run binding, never inferred or accepted over HTTP.
CREATE TABLE IF NOT EXISTS deviation_import_sources (
  site_id UUID PRIMARY KEY NOT NULL REFERENCES sites(id),
  scope_id UUID NOT NULL,
  run_id UUID NOT NULL,
  promoted_run_id UUID,
  promoted_batch_id UUID,
  promoted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Reserved for a future classification decision; no default or allowed-value constraint.
ALTER TABLE tasks ADD COLUMN kind TEXT;
