-- Save referencing rows while replacing the legacy deviation-number constraint.
CREATE TEMP TABLE saved_deviation_links AS SELECT * FROM deviation_links;
DROP TABLE deviation_links;
CREATE TEMP TABLE saved_cost_impact_deviations AS SELECT * FROM cost_impact_deviations;
DROP TABLE cost_impact_deviations;
CREATE TEMP TABLE saved_hse_events AS SELECT * FROM hse_events;
DROP TABLE hse_events;

CREATE TABLE deviations_038 (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  deviation_no TEXT, title TEXT, problem_description TEXT,
  status TEXT CHECK (status IN ('open', 'approved', 'in_progress', 'work_completed', 'closed', 'rejected')),
  priority TEXT, author TEXT, assigned_to TEXT, plc_area TEXT,
  creation_date TEXT, due_date TEXT, approved_date TEXT, closed_date TEXT,
  actual_cost NUMERIC, claim_quantity NUMERIC, labor_hours NUMERIC, completed_tasks_pct NUMERIC,
  source_entity_key_id TEXT,
  created_at TEXT NOT NULL,
  source_system TEXT CHECK (source_system IN ('internal', 'other')),
  source_id TEXT CHECK (source_id IS NULL OR (source_system IS NOT NULL AND length(trim(source_id)) > 0)),
  source_status TEXT,
  source_export_date TEXT,
  last_seen_in_export_date TEXT,
  provenance TEXT NOT NULL DEFAULT 'original' CHECK (provenance IN ('original', 'derived', 'reported')),
  causing_company TEXT,
  resolving_company TEXT,
  attribution_state TEXT NOT NULL DEFAULT 'not_determined' CHECK (attribution_state IN ('not_determined', 'agreed', 'disputed')),
  internal_owner_id TEXT REFERENCES users(id),
  internal_owner_since TEXT
);
INSERT INTO deviations_038 (id, site_id, deviation_no, title, problem_description, status, priority, author, assigned_to, plc_area,
  creation_date, due_date, approved_date, closed_date, actual_cost, claim_quantity, labor_hours,
  completed_tasks_pct, source_entity_key_id, created_at) SELECT id, site_id, deviation_no, title, problem_description, status, priority, author, assigned_to, plc_area,
  creation_date, due_date, approved_date, closed_date, actual_cost, claim_quantity, labor_hours,
  completed_tasks_pct, source_entity_key_id, created_at FROM deviations;
DROP TABLE deviations;
ALTER TABLE deviations_038 RENAME TO deviations;
CREATE INDEX deviations_site_status ON deviations(site_id, status);
CREATE INDEX deviations_site_priority ON deviations(site_id, priority);

CREATE TABLE IF NOT EXISTS deviation_links (
  deviation_id TEXT NOT NULL REFERENCES deviations(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('site_progress_item', 'work_day', 'task', 'diary')),
  entity_id TEXT NOT NULL,
  PRIMARY KEY (deviation_id, entity_type, entity_id)
);
INSERT INTO deviation_links SELECT * FROM saved_deviation_links;
DROP TABLE saved_deviation_links;

CREATE TABLE IF NOT EXISTS cost_impact_deviations (
  cost_impact_id TEXT NOT NULL REFERENCES cost_impacts(id),
  deviation_id TEXT NOT NULL REFERENCES deviations(id),
  PRIMARY KEY (cost_impact_id, deviation_id)
);
INSERT INTO cost_impact_deviations SELECT * FROM saved_cost_impact_deviations;
DROP TABLE saved_cost_impact_deviations;

CREATE TABLE IF NOT EXISTS hse_events (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  event_no TEXT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  occurred_on DATE NOT NULL,
  location TEXT,
  persons_involved INTEGER,
  measures TEXT,
  notes TEXT,
  deviation_id TEXT REFERENCES deviations(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (site_id, event_no)
);
INSERT INTO hse_events SELECT * FROM saved_hse_events;
DROP TABLE saved_hse_events;
CREATE INDEX hse_events_site_occurred ON hse_events(site_id, occurred_on);
CREATE INDEX hse_events_site_type ON hse_events(site_id, type);

CREATE TABLE attachments_with_deviation (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('task', 'diary', 'site', 'hse_event', 'hse_inspection', 'deviation')),
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
INSERT INTO attachments_with_deviation
  (id, site_id, entity_type, entity_id, filename, mime, size, content_sha256,
   storage_locator, manifest_version, uploaded_by, created_at)
  SELECT id, site_id, entity_type, entity_id, filename, mime, size, content_sha256,
    storage_locator, manifest_version, uploaded_by, created_at FROM attachments;
DROP TABLE attachments;
ALTER TABLE attachments_with_deviation RENAME TO attachments;
CREATE INDEX attachments_entity ON attachments (site_id, entity_type, entity_id);

CREATE TABLE audit_events_038 (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('hse_event', 'certification', 'tool', 'site', 'hse_asset', 'hse_inspection', 'purchase_order', 'purchase_order_item', 'package', 'package_item', 'shipment', 'shipment_receipt', 'deviation', 'task')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'read')),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  changes TEXT NOT NULL
);
INSERT INTO audit_events_038 SELECT * FROM audit_events;
DROP TABLE audit_events;
ALTER TABLE audit_events_038 RENAME TO audit_events;
CREATE INDEX audit_events_site_at ON audit_events(site_id, at, id);
CREATE INDEX audit_events_site_entity ON audit_events(site_id, entity_type, entity_id, at, id);

CREATE UNIQUE INDEX deviations_legacy_number ON deviations(site_id, deviation_no) WHERE source_system IS NULL;
CREATE UNIQUE INDEX deviations_external_identity ON deviations(site_id, source_system, source_id) WHERE source_id IS NOT NULL;
CREATE TRIGGER deviations_source_identity BEFORE UPDATE OF source_id, source_system, site_id ON deviations
WHEN OLD.source_id IS NOT NULL
  AND (NEW.source_id IS NOT OLD.source_id OR NEW.source_system IS NOT OLD.source_system OR NEW.site_id IS NOT OLD.site_id)
BEGIN
  SELECT RAISE(ABORT, 'Deviation source identity is immutable');
END;
CREATE INDEX deviations_site_last_seen ON deviations(site_id, last_seen_in_export_date);
CREATE INDEX deviations_site_internal_owner ON deviations(site_id, internal_owner_id);

CREATE TABLE deviation_exports (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  source_system TEXT NOT NULL CHECK (source_system IN ('internal', 'other')),
  export_date TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  complete BOOLEAN NOT NULL,
  scope TEXT NOT NULL,
  UNIQUE (site_id, source_system, export_date, file_sha256, complete, scope)
);
CREATE INDEX deviation_exports_site_system_date ON deviation_exports(site_id, source_system, export_date DESC, id DESC);
CREATE TABLE deviation_export_rows (
  export_id INTEGER NOT NULL REFERENCES deviation_exports(id) ON DELETE CASCADE,
  deviation_id TEXT NOT NULL REFERENCES deviations(id),
  PRIMARY KEY (export_id, deviation_id)
);

CREATE TABLE deviation_events (
  id INTEGER PRIMARY KEY,
  deviation_id TEXT NOT NULL REFERENCES deviations(id),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  source TEXT NOT NULL CHECK (source IN ('import', 'internal')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  action TEXT,
  note TEXT,
  CHECK ((source = 'import' AND actor = 'import' AND actor_id IS NULL)
      OR (source = 'internal' AND actor_id IS NOT NULL))
);
CREATE INDEX deviation_events_timeline ON deviation_events(deviation_id, at, id);
CREATE TRIGGER deviation_events_no_update BEFORE UPDATE ON deviation_events
BEGIN
  SELECT RAISE(ABORT, 'Deviation events are append-only');
END;
CREATE TRIGGER deviation_events_no_delete BEFORE DELETE ON deviation_events
BEGIN
  SELECT RAISE(ABORT, 'Deviation events are append-only');
END;

ALTER TABLE tasks ADD COLUMN declared_at TEXT;
ALTER TABLE tasks ADD COLUMN verified_at TEXT;
ALTER TABLE tasks ADD COLUMN acceptance_document_id TEXT REFERENCES attachments(id);
ALTER TABLE tasks ADD COLUMN acceptance_date TEXT;
ALTER TABLE tasks ADD COLUMN acceptance_state TEXT NOT NULL DEFAULT 'none'
  CHECK (acceptance_state IN ('none', 'declared', 'accepted')
    AND (acceptance_state <> 'accepted' OR (acceptance_document_id IS NOT NULL AND acceptance_date IS NOT NULL)));
ALTER TABLE task_events ADD COLUMN waiver BOOLEAN NOT NULL DEFAULT FALSE
  CHECK (NOT waiver OR (action IS NOT NULL AND action = 'close' AND reason IS NOT NULL AND length(trim(reason)) >= 15));
ALTER TABLE task_events ADD COLUMN evidence_attachment_id TEXT REFERENCES attachments(id);
CREATE INDEX task_events_evidence_attachment ON task_events(evidence_attachment_id);
CREATE INDEX task_events_current_closure ON task_events(task_id, to_status, from_status, id);
