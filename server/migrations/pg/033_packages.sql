CREATE TABLE packages (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id),
  package_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  notes TEXT,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (purchase_order_id, package_no)
);
CREATE INDEX packages_site_order ON packages(site_id, purchase_order_id);

CREATE TABLE package_items (
  id UUID PRIMARY KEY NOT NULL,
  package_id UUID NOT NULL REFERENCES packages(id),
  purchase_order_item_id UUID NOT NULL REFERENCES purchase_order_items(id),
  quantity_packed NUMERIC(12,3) NOT NULL CHECK (quantity_packed > 0),
  unit TEXT,
  material_no TEXT,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (package_id, purchase_order_item_id)
);
CREATE INDEX package_items_order_item ON package_items(purchase_order_item_id);

ALTER TABLE audit_events DROP CONSTRAINT audit_events_entity_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_entity_type_check
  CHECK (entity_type IN ('hse_event', 'certification', 'tool', 'site', 'hse_asset', 'hse_inspection', 'purchase_order', 'purchase_order_item', 'package', 'package_item'));
