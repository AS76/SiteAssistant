CREATE TABLE shipments (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  shipment_no TEXT NOT NULL,
  carrier TEXT,
  shipped_on DATE,
  expected_on DATE,
  arrived_on DATE,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_transit', 'arrived', 'received')),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, shipment_no)
);
CREATE INDEX shipments_site_status ON shipments(site_id, status);

CREATE TABLE shipment_packages (
  shipment_id TEXT NOT NULL REFERENCES shipments(id),
  package_id TEXT NOT NULL REFERENCES packages(id),
  PRIMARY KEY (shipment_id, package_id),
  UNIQUE (package_id)
);

CREATE TABLE shipment_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  shipment_id TEXT NOT NULL REFERENCES shipments(id),
  purchase_order_item_id TEXT NOT NULL REFERENCES purchase_order_items(id),
  quantity_received NUMERIC(12,3) NOT NULL CHECK (quantity_received >= 0),
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX shipment_receipts_shipment ON shipment_receipts(shipment_id);

CREATE TABLE audit_events_with_shipments (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('hse_event', 'certification', 'tool', 'site', 'hse_asset', 'hse_inspection', 'purchase_order', 'purchase_order_item', 'package', 'package_item', 'shipment', 'shipment_receipt')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'read')),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  changes TEXT NOT NULL
);
INSERT INTO audit_events_with_shipments SELECT * FROM audit_events;
DROP TABLE audit_events;
ALTER TABLE audit_events_with_shipments RENAME TO audit_events;
CREATE INDEX audit_events_site_at ON audit_events(site_id, at, id);
CREATE INDEX audit_events_site_entity ON audit_events(site_id, entity_type, entity_id, at, id);
