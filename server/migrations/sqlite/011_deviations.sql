-- Read-only application projection; ingestion schemas are provisioned separately.
CREATE TABLE IF NOT EXISTS deviations (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  deviation_no TEXT, title TEXT, problem_description TEXT,
  status TEXT CHECK (status IN ('open', 'approved', 'in_progress', 'work_completed', 'closed', 'rejected')),
  priority TEXT, author TEXT, assigned_to TEXT, plc_area TEXT,
  creation_date TEXT, due_date TEXT, approved_date TEXT, closed_date TEXT,
  actual_cost NUMERIC, claim_quantity NUMERIC, labor_hours NUMERIC, completed_tasks_pct NUMERIC,
  source_entity_key_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (site_id, deviation_no)
);
CREATE INDEX IF NOT EXISTS deviations_site_status ON deviations(site_id, status);
CREATE INDEX IF NOT EXISTS deviations_site_priority ON deviations(site_id, priority);

-- Polymorphic targets are explicit references; only the deviation has a foreign key.
CREATE TABLE IF NOT EXISTS deviation_links (
  deviation_id TEXT NOT NULL REFERENCES deviations(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('site_progress_item', 'work_day', 'task', 'diary')),
  entity_id TEXT NOT NULL,
  PRIMARY KEY (deviation_id, entity_type, entity_id)
);

-- Trusted site/scope/run binding, never inferred or accepted over HTTP.
CREATE TABLE IF NOT EXISTS deviation_import_sources (
  site_id TEXT PRIMARY KEY NOT NULL REFERENCES sites(id),
  scope_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  promoted_run_id TEXT,
  promoted_batch_id TEXT,
  promoted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Reserved for a future classification decision; no default or allowed-value constraint.
ALTER TABLE tasks ADD COLUMN kind TEXT;
