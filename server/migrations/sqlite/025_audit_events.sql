ALTER TABLE hse_events ADD COLUMN deleted_at TEXT;
ALTER TABLE employee_certifications ADD COLUMN deleted_at TEXT;
ALTER TABLE tools ADD COLUMN deleted_at TEXT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('hse_event', 'certification', 'tool')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  changes TEXT NOT NULL
);
CREATE INDEX audit_events_site_at ON audit_events(site_id, at, id);
CREATE INDEX audit_events_site_entity ON audit_events(site_id, entity_type, entity_id, at, id);
