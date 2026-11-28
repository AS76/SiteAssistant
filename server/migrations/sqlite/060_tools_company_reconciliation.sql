-- Reconciliation preserves legacy values and tracks the revision of each source occurrence.
ALTER TABLE tools ADD COLUMN reconciliation_revision INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX tools_site_identity ON tools(site_id, id);

CREATE TABLE reconciliation_adoptions (
  site_id UUID NOT NULL REFERENCES sites(id),
  module TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  revision INTEGER NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL,
  changed_by UUID NOT NULL REFERENCES users(id),
  PRIMARY KEY (site_id, module)
);

CREATE TABLE reconciliation_batches (
  site_id UUID NOT NULL REFERENCES sites(id),
  module TEXT NOT NULL,
  id UUID NOT NULL,
  adoption_revision INTEGER NOT NULL,
  decision_hash TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  decided_by UUID NOT NULL REFERENCES users(id),
  applied_at TIMESTAMPTZ,
  applied_by UUID REFERENCES users(id),
  apply_result TEXT,
  rolled_back_at TIMESTAMPTZ,
  rolled_back_by UUID REFERENCES users(id),
  rollback_result TEXT,
  PRIMARY KEY (site_id, module, id)
);

CREATE TABLE reconciliation_items (
  site_id UUID NOT NULL,
  module TEXT NOT NULL,
  batch_id UUID NOT NULL,
  record_id UUID NOT NULL,
  field TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  source_snapshot TEXT NOT NULL,
  decision TEXT NOT NULL,
  target_snapshot TEXT,
  applied_at TIMESTAMPTZ,
  PRIMARY KEY (site_id, module, batch_id, record_id, field),
  FOREIGN KEY (site_id, module, batch_id) REFERENCES reconciliation_batches(site_id, module, id)
);
CREATE UNIQUE INDEX reconciliation_applied_occurrence ON reconciliation_items(site_id, module, record_id, field, source_revision)
  WHERE applied_at IS NOT NULL;
CREATE INDEX reconciliation_record_history ON reconciliation_items(site_id, module, record_id);

CREATE TABLE tool_company_links (
  site_id UUID NOT NULL,
  tool_id UUID NOT NULL,
  company_id UUID NOT NULL,
  company_label TEXT NOT NULL,
  relationship TEXT NOT NULL CHECK (relationship IN ('owner', 'custodian', 'supplier')),
  linked_at TIMESTAMPTZ NOT NULL,
  batch_id UUID NOT NULL,
  module TEXT NOT NULL DEFAULT 'tools' CHECK (module = 'tools'),
  PRIMARY KEY (site_id, tool_id),
  FOREIGN KEY (site_id, tool_id) REFERENCES tools(site_id, id),
  FOREIGN KEY (site_id, company_id) REFERENCES registry_companies(site_id, id),
  FOREIGN KEY (site_id, module, batch_id) REFERENCES reconciliation_batches(site_id, module, id)
);
CREATE INDEX tool_company_links_company ON tool_company_links(site_id, company_id);
