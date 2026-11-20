CREATE TABLE hse_assets (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  kind TEXT NOT NULL CHECK (kind IN ('tool', 'site_work', 'ppe')),
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT,
  tool_id UUID REFERENCES tools(id),
  template_code TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (site_id, name)
);
CREATE INDEX hse_assets_site_kind ON hse_assets(site_id, kind);

ALTER TABLE audit_events DROP CONSTRAINT audit_events_entity_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_entity_type_check
  CHECK (entity_type IN ('hse_event', 'certification', 'tool', 'site', 'hse_asset'));
