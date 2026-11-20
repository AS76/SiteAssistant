CREATE TABLE hse_inspections (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  asset_id TEXT NOT NULL REFERENCES hse_assets(id),
  performed_on DATE NOT NULL,
  performed_by TEXT NOT NULL,
  performer_role TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('internal', 'external')),
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'pass_with_notes', 'fail')),
  notes TEXT,
  next_due_on DATE,
  hse_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX hse_inspections_site_asset_performed ON hse_inspections(site_id, asset_id, performed_on);

CREATE TABLE hse_inspection_items (
  id TEXT PRIMARY KEY NOT NULL,
  inspection_id TEXT NOT NULL REFERENCES hse_inspections(id),
  item_code TEXT NOT NULL,
  label TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('ok', 'not_ok', 'na')),
  note TEXT,
  position INTEGER NOT NULL,
  UNIQUE (inspection_id, item_code)
);

CREATE TABLE audit_events_with_inspections (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('hse_event', 'certification', 'tool', 'site', 'hse_asset', 'hse_inspection')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'read')),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  changes TEXT NOT NULL
);
INSERT INTO audit_events_with_inspections SELECT * FROM audit_events;
DROP TABLE audit_events;
ALTER TABLE audit_events_with_inspections RENAME TO audit_events;
CREATE INDEX audit_events_site_at ON audit_events(site_id, at, id);
CREATE INDEX audit_events_site_entity ON audit_events(site_id, entity_type, entity_id, at, id);
