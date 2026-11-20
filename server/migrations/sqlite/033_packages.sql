CREATE TABLE packages (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  package_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  notes TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (purchase_order_id, package_no)
);
CREATE INDEX packages_site_order ON packages(site_id, purchase_order_id);

CREATE TABLE package_items (
  id TEXT PRIMARY KEY NOT NULL,
  package_id TEXT NOT NULL REFERENCES packages(id),
  purchase_order_item_id TEXT NOT NULL REFERENCES purchase_order_items(id),
  quantity_packed NUMERIC(12,3) NOT NULL CHECK (quantity_packed > 0),
  unit TEXT,
  material_no TEXT,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (package_id, purchase_order_item_id)
);
CREATE INDEX package_items_order_item ON package_items(purchase_order_item_id);

CREATE TABLE audit_events_with_packages (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('hse_event', 'certification', 'tool', 'site', 'hse_asset', 'hse_inspection', 'purchase_order', 'purchase_order_item', 'package', 'package_item')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'read')),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  changes TEXT NOT NULL
);
INSERT INTO audit_events_with_packages SELECT * FROM audit_events;
DROP TABLE audit_events;
ALTER TABLE audit_events_with_packages RENAME TO audit_events;
CREATE INDEX audit_events_site_at ON audit_events(site_id, at, id);
CREATE INDEX audit_events_site_entity ON audit_events(site_id, entity_type, entity_id, at, id);
