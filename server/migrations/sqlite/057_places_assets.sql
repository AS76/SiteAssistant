CREATE TABLE places (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  parent_id UUID,
  kind TEXT NOT NULL CHECK (kind IN ('building', 'floor', 'zone', 'room')),
  name TEXT NOT NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  UNIQUE (site_id, id),
  FOREIGN KEY (site_id, parent_id) REFERENCES places(site_id, id),
  CHECK (parent_id <> id)
);
CREATE INDEX places_site_parent ON places(site_id, parent_id);

CREATE TABLE assets (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  tag TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'installed', 'replaced', 'decommissioned')),
  serial_number TEXT,
  manufacturer TEXT,
  model TEXT,
  installed_on TEXT,
  commissioned_on TEXT,
  warranty_start TEXT,
  warranty_end TEXT,
  warranty_provider TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, id),
  CHECK (warranty_end >= warranty_start),
  CHECK (status <> 'installed' OR installed_on IS NOT NULL)
);
CREATE UNIQUE INDEX assets_site_active_tag ON assets(site_id, tag) WHERE archived_at IS NULL;

CREATE TABLE asset_positions (
  asset_id UUID NOT NULL,
  place_id UUID NOT NULL,
  site_id UUID NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  reason TEXT,
  recorded_path TEXT NOT NULL,
  PRIMARY KEY (asset_id, valid_from),
  FOREIGN KEY (site_id, asset_id) REFERENCES assets(site_id, id),
  FOREIGN KEY (site_id, place_id) REFERENCES places(site_id, id),
  CHECK (valid_to > valid_from)
);
CREATE UNIQUE INDEX asset_positions_open ON asset_positions(asset_id) WHERE valid_to IS NULL;
CREATE INDEX asset_positions_open_place ON asset_positions(site_id, place_id) WHERE valid_to IS NULL;
CREATE TABLE audit_events_057 (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('hse_event', 'certification', 'tool', 'site', 'hse_asset', 'hse_inspection', 'purchase_order', 'purchase_order_item', 'package', 'package_item', 'shipment', 'shipment_receipt', 'deviation', 'task', 'place', 'asset')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'read', 'move', 'archive')),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  changes TEXT NOT NULL
);
INSERT INTO audit_events_057 SELECT * FROM audit_events;
DROP TABLE audit_events;
ALTER TABLE audit_events_057 RENAME TO audit_events;
CREATE INDEX audit_events_site_at ON audit_events(site_id, at, id);
CREATE INDEX audit_events_site_entity ON audit_events(site_id, entity_type, entity_id, at, id);
