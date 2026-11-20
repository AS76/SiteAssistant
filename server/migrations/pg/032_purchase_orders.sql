CREATE TABLE purchase_orders (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  po_no TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  ordered_on DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'template_generated', 'in_execution', 'completed', 'not_relevant')),
  notes TEXT,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (site_id, po_no)
);
CREATE INDEX purchase_orders_site_status ON purchase_orders(site_id, status);

CREATE TABLE purchase_order_items (
  id UUID PRIMARY KEY NOT NULL,
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id),
  line_no INTEGER NOT NULL,
  material_no TEXT,
  description TEXT NOT NULL,
  unit TEXT,
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  wbs_id UUID REFERENCES project_structure(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_execution', 'completed', 'not_relevant')),
  execution_started_on DATE,
  completed_on DATE,
  not_relevant_on DATE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (purchase_order_id, line_no)
);

ALTER TABLE audit_events DROP CONSTRAINT audit_events_entity_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_entity_type_check
  CHECK (entity_type IN ('hse_event', 'certification', 'tool', 'site', 'hse_asset', 'hse_inspection', 'purchase_order', 'purchase_order_item'));
