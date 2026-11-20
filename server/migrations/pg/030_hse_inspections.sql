CREATE TABLE hse_inspections (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  asset_id UUID NOT NULL REFERENCES hse_assets(id),
  performed_on DATE NOT NULL,
  performed_by TEXT NOT NULL,
  performer_role TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('internal', 'external')),
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'pass_with_notes', 'fail')),
  notes TEXT,
  next_due_on DATE,
  hse_event_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX hse_inspections_site_asset_performed ON hse_inspections(site_id, asset_id, performed_on);

CREATE TABLE hse_inspection_items (
  id UUID PRIMARY KEY NOT NULL,
  inspection_id UUID NOT NULL REFERENCES hse_inspections(id),
  item_code TEXT NOT NULL,
  label TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('ok', 'not_ok', 'na')),
  note TEXT,
  position INTEGER NOT NULL,
  UNIQUE (inspection_id, item_code)
);

ALTER TABLE audit_events DROP CONSTRAINT audit_events_entity_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_entity_type_check
  CHECK (entity_type IN ('hse_event', 'certification', 'tool', 'site', 'hse_asset', 'hse_inspection'));
