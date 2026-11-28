-- Site-local registers. Operational authority is separate from application membership.
CREATE TABLE registry_people (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  name TEXT NOT NULL,
  search_name TEXT NOT NULL,
  given_name TEXT,
  family_name TEXT,
  language TEXT CHECK (language IN ('it', 'en')),
  archived_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  UNIQUE (site_id, id)
);

CREATE TABLE registry_companies (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  name TEXT NOT NULL,
  search_name TEXT NOT NULL,
  archived_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  UNIQUE (site_id, id)
);

CREATE TABLE registry_teams (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  name TEXT NOT NULL,
  search_name TEXT NOT NULL,
  lead_company_id UUID,
  archived_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  UNIQUE (site_id, id),
  FOREIGN KEY (site_id, lead_company_id) REFERENCES registry_companies(site_id, id)
);

CREATE TABLE registry_affiliations (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  person_id UUID NOT NULL,
  company_id UUID NOT NULL,
  relationship TEXT NOT NULL,
  source TEXT NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  UNIQUE (site_id, id),
  FOREIGN KEY (site_id, person_id) REFERENCES registry_people(site_id, id),
  FOREIGN KEY (site_id, company_id) REFERENCES registry_companies(site_id, id),
  CHECK (valid_to > valid_from)
);

CREATE TABLE registry_company_roles (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  company_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('contractor', 'subcontractor', 'inspection_body', 'supplier')),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  UNIQUE (site_id, id),
  FOREIGN KEY (site_id, company_id) REFERENCES registry_companies(site_id, id),
  CHECK (valid_to > valid_from)
);

CREATE TABLE registry_team_memberships (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  team_id UUID NOT NULL,
  person_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('member', 'lead')),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  UNIQUE (site_id, id),
  FOREIGN KEY (site_id, team_id) REFERENCES registry_teams(site_id, id),
  FOREIGN KEY (site_id, person_id) REFERENCES registry_people(site_id, id),
  CHECK (valid_to > valid_from)
);

CREATE TABLE registry_account_links (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  person_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES users(id),
  valid_from TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  UNIQUE (site_id, id),
  FOREIGN KEY (site_id, person_id) REFERENCES registry_people(site_id, id)
);

CREATE TABLE registry_authority_roles (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  person_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('executor', 'verifier', 'inspector')),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  UNIQUE (site_id, id),
  FOREIGN KEY (site_id, person_id) REFERENCES registry_people(site_id, id),
  CHECK (valid_to > valid_from)
);

CREATE TABLE registry_authority_delegations (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  authority_role_id UUID NOT NULL,
  grantor_link_id UUID NOT NULL,
  recipient_link_id UUID NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  UNIQUE (site_id, id),
  FOREIGN KEY (site_id, authority_role_id) REFERENCES registry_authority_roles(site_id, id),
  FOREIGN KEY (site_id, grantor_link_id) REFERENCES registry_account_links(site_id, id),
  FOREIGN KEY (site_id, recipient_link_id) REFERENCES registry_account_links(site_id, id),
  CHECK (grantor_link_id <> recipient_link_id),
  CHECK (valid_to > valid_from)
);

CREATE TABLE registry_authority_snapshots (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  authority_role_id UUID NOT NULL,
  delegation_id UUID,
  account_link_id UUID NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  actor_id UUID NOT NULL REFERENCES users(id),
  evidence TEXT NOT NULL,
  FOREIGN KEY (site_id, authority_role_id) REFERENCES registry_authority_roles(site_id, id),
  FOREIGN KEY (site_id, delegation_id) REFERENCES registry_authority_delegations(site_id, id),
  FOREIGN KEY (site_id, account_link_id) REFERENCES registry_account_links(site_id, id)
);

CREATE TABLE registry_history (
  site_id UUID NOT NULL REFERENCES sites(id),
  collection TEXT NOT NULL,
  record_id UUID NOT NULL,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  actor_id UUID NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  before_state TEXT,
  after_state TEXT NOT NULL,
  PRIMARY KEY (site_id, collection, record_id, revision)
);

CREATE INDEX registry_people_label ON registry_people(site_id, search_name, id);
CREATE INDEX registry_companies_label ON registry_companies(site_id, search_name, id);
CREATE INDEX registry_teams_label ON registry_teams(site_id, search_name, id);
CREATE INDEX registry_teams_company ON registry_teams(site_id, lead_company_id);
CREATE INDEX registry_affiliations_person ON registry_affiliations(site_id, person_id, company_id, relationship, valid_from);
CREATE INDEX registry_affiliations_company ON registry_affiliations(site_id, company_id);
CREATE INDEX registry_company_roles_company ON registry_company_roles(site_id, company_id, role, valid_from);
CREATE INDEX registry_team_memberships_team_role ON registry_team_memberships(site_id, team_id, role, valid_from);
CREATE INDEX registry_team_memberships_person ON registry_team_memberships(site_id, person_id);
CREATE INDEX registry_authority_roles_person ON registry_authority_roles(site_id, person_id, role, valid_from);
CREATE INDEX registry_authority_delegations_role_recipient ON registry_authority_delegations(site_id, authority_role_id, recipient_link_id, valid_from);
CREATE INDEX registry_authority_snapshots_recorded ON registry_authority_snapshots(site_id, recorded_at, id);
CREATE UNIQUE INDEX registry_account_links_open_person
  ON registry_account_links(site_id, person_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX registry_account_links_open_account
  ON registry_account_links(site_id, account_id) WHERE revoked_at IS NULL;
