CREATE TABLE hse_assets (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  kind TEXT NOT NULL CHECK (kind IN ('tool', 'site_work', 'ppe')),
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT,
  tool_id UUID REFERENCES tools(id),
  template_code TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, name)
);
CREATE INDEX hse_assets_site_kind ON hse_assets(site_id, kind);

CREATE TABLE audit_events_with_assets (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('hse_event', 'certification', 'tool', 'site', 'hse_asset')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'read')),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  changes TEXT NOT NULL
);
INSERT INTO audit_events_with_assets SELECT * FROM audit_events;
DROP TABLE audit_events;
ALTER TABLE audit_events_with_assets RENAME TO audit_events;
CREATE INDEX audit_events_site_at ON audit_events(site_id, at, id);
CREATE INDEX audit_events_site_entity ON audit_events(site_id, entity_type, entity_id, at, id);
