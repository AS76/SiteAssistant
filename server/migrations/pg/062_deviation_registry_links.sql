-- Registry references preserve the approved occurrence independently of deviation governance.
CREATE UNIQUE INDEX deviations_site_identity ON deviations(site_id, id);

CREATE TABLE deviation_registry_source_revisions (
  site_id UUID NOT NULL,
  deviation_id UUID NOT NULL,
  field TEXT NOT NULL,
  revision INTEGER NOT NULL,
  CONSTRAINT deviation_registry_source_revisions_pkey PRIMARY KEY (site_id, deviation_id, field),
  CONSTRAINT deviation_registry_revision_source_fk FOREIGN KEY (site_id, deviation_id) REFERENCES deviations(site_id, id) ON DELETE CASCADE,
  CONSTRAINT deviation_registry_revision_field_check CHECK (field IN ('author', 'assigned_to')),
  CONSTRAINT deviation_registry_revision_value_check CHECK (revision > 0)
);

CREATE TABLE deviation_registry_links (
  site_id UUID NOT NULL,
  deviation_id UUID NOT NULL,
  field TEXT NOT NULL,
  version INTEGER NOT NULL,
  person_id UUID,
  team_id UUID,
  company_id UUID,
  original_label TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  end_action TEXT,
  batch_id UUID NOT NULL,
  module TEXT NOT NULL DEFAULT 'deviations',
  CONSTRAINT deviation_registry_links_pkey PRIMARY KEY (site_id, deviation_id, field, version),
  CONSTRAINT deviation_registry_source_fk FOREIGN KEY (site_id, deviation_id) REFERENCES deviations(site_id, id),
  CONSTRAINT deviation_registry_person_fk FOREIGN KEY (site_id, person_id) REFERENCES registry_people(site_id, id),
  CONSTRAINT deviation_registry_team_fk FOREIGN KEY (site_id, team_id) REFERENCES registry_teams(site_id, id),
  CONSTRAINT deviation_registry_company_fk FOREIGN KEY (site_id, company_id) REFERENCES registry_companies(site_id, id),
  CONSTRAINT deviation_registry_item_fk FOREIGN KEY (site_id, module, batch_id, deviation_id, field)
    REFERENCES reconciliation_items(site_id, module, batch_id, record_id, field),
  CONSTRAINT deviation_registry_module_check CHECK (module = 'deviations'),
  CONSTRAINT deviation_registry_version_check CHECK (version > 0),
  CONSTRAINT deviation_registry_target_check CHECK (
    (field IN ('author', 'assigned_to') AND person_id IS NOT NULL AND team_id IS NULL AND company_id IS NULL)
    OR (field = 'assigned_to' AND team_id IS NOT NULL AND person_id IS NULL AND company_id IS NULL)
    OR (field IN ('causing_company', 'resolving_company') AND company_id IS NOT NULL AND person_id IS NULL AND team_id IS NULL)
  ),
  CONSTRAINT deviation_registry_end_check CHECK (
    (valid_to IS NULL AND end_action IS NULL)
    OR (valid_to IS NOT NULL AND valid_to >= valid_from AND end_action IS NOT NULL AND end_action IN ('superseded', 'compensated'))
  )
);
CREATE UNIQUE INDEX deviation_registry_current ON deviation_registry_links(site_id, deviation_id, field) WHERE valid_to IS NULL;
