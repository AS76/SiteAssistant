-- Task attribution is separate from the original labels and account assignments.
CREATE UNIQUE INDEX tasks_site_identity ON tasks(site_id, id);

CREATE TABLE task_assignment_links (
  site_id UUID NOT NULL,
  task_id UUID NOT NULL,
  field TEXT NOT NULL,
  version INTEGER NOT NULL,
  person_id UUID,
  team_id UUID,
  company_id UUID,
  authority_role_id UUID,
  original_label TEXT,
  snapshot TEXT NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  end_action TEXT,
  batch_id UUID NOT NULL,
  module TEXT NOT NULL DEFAULT 'tasks',
  CONSTRAINT task_assignment_links_pkey PRIMARY KEY (site_id, task_id, field, version),
  CONSTRAINT task_assignment_task_fk FOREIGN KEY (site_id, task_id) REFERENCES tasks(site_id, id),
  CONSTRAINT task_assignment_person_fk FOREIGN KEY (site_id, person_id) REFERENCES registry_people(site_id, id),
  CONSTRAINT task_assignment_team_fk FOREIGN KEY (site_id, team_id) REFERENCES registry_teams(site_id, id),
  CONSTRAINT task_assignment_company_fk FOREIGN KEY (site_id, company_id) REFERENCES registry_companies(site_id, id),
  CONSTRAINT task_assignment_authority_fk FOREIGN KEY (site_id, authority_role_id) REFERENCES registry_authority_roles(site_id, id),
  CONSTRAINT task_assignment_batch_fk FOREIGN KEY (site_id, module, batch_id) REFERENCES reconciliation_batches(site_id, module, id),
  CONSTRAINT task_assignment_module_check CHECK (module = 'tasks'),
  CONSTRAINT task_assignment_version_check CHECK (version > 0),
  CONSTRAINT task_assignment_target_check CHECK (
    (field IN ('executor', 'verifier') AND person_id IS NOT NULL AND authority_role_id IS NOT NULL AND team_id IS NULL AND company_id IS NULL)
    OR (field = 'executor' AND team_id IS NOT NULL AND person_id IS NULL AND company_id IS NULL AND authority_role_id IS NULL)
    OR (field = 'company' AND company_id IS NOT NULL AND person_id IS NULL AND team_id IS NULL AND authority_role_id IS NULL)
  ),
  CONSTRAINT task_assignment_end_check CHECK (
    (valid_to IS NULL AND end_action IS NULL)
    OR (valid_to IS NOT NULL AND valid_to >= valid_from AND end_action IS NOT NULL AND end_action IN ('superseded', 'compensated'))
  )
);
CREATE UNIQUE INDEX task_assignment_current ON task_assignment_links(site_id, task_id, field) WHERE valid_to IS NULL;
CREATE INDEX task_assignment_person ON task_assignment_links(site_id, person_id) WHERE valid_to IS NULL;
CREATE INDEX task_assignment_team ON task_assignment_links(site_id, team_id) WHERE valid_to IS NULL;
CREATE INDEX task_assignment_company ON task_assignment_links(site_id, company_id) WHERE valid_to IS NULL;
