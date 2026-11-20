CREATE TABLE shipments (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  shipment_no TEXT NOT NULL,
  carrier TEXT,
  shipped_on DATE,
  expected_on DATE,
  arrived_on DATE,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_transit', 'arrived', 'received')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (site_id, shipment_no)
);
CREATE INDEX shipments_site_status ON shipments(site_id, status);

CREATE TABLE shipment_packages (
  shipment_id UUID NOT NULL REFERENCES shipments(id),
  package_id UUID NOT NULL REFERENCES packages(id),
  PRIMARY KEY (shipment_id, package_id),
  UNIQUE (package_id)
);

CREATE TABLE shipment_receipts (
  id UUID PRIMARY KEY NOT NULL,
  shipment_id UUID NOT NULL REFERENCES shipments(id),
  purchase_order_item_id UUID NOT NULL REFERENCES purchase_order_items(id),
  quantity_received NUMERIC(12,3) NOT NULL CHECK (quantity_received >= 0),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX shipment_receipts_shipment ON shipment_receipts(shipment_id);

ALTER TABLE audit_events DROP CONSTRAINT audit_events_entity_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_entity_type_check
  CHECK (entity_type IN ('hse_event', 'certification', 'tool', 'site', 'hse_asset', 'hse_inspection', 'purchase_order', 'purchase_order_item', 'package', 'package_item', 'shipment', 'shipment_receipt'));
