CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  po_no TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  ordered_on DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'template_generated', 'in_execution', 'completed', 'not_relevant')),
  notes TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, po_no)
);
CREATE INDEX purchase_orders_site_status ON purchase_orders(site_id, status);

CREATE TABLE purchase_order_items (
  id TEXT PRIMARY KEY NOT NULL,
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  line_no INTEGER NOT NULL,
  material_no TEXT,
  description TEXT NOT NULL,
  unit TEXT,
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  wbs_id TEXT REFERENCES project_structure(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_execution', 'completed', 'not_relevant')),
  execution_started_on DATE,
  completed_on DATE,
  not_relevant_on DATE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (purchase_order_id, line_no)
);

CREATE TABLE audit_events_with_purchase_orders (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('hse_event', 'certification', 'tool', 'site', 'hse_asset', 'hse_inspection', 'purchase_order', 'purchase_order_item')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'read')),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  changes TEXT NOT NULL
);
INSERT INTO audit_events_with_purchase_orders SELECT * FROM audit_events;
DROP TABLE audit_events;
ALTER TABLE audit_events_with_purchase_orders RENAME TO audit_events;
CREATE INDEX audit_events_site_at ON audit_events(site_id, at, id);
CREATE INDEX audit_events_site_entity ON audit_events(site_id, entity_type, entity_id, at, id);
