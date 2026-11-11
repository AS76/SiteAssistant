CREATE TABLE IF NOT EXISTS employee_certifications (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  employee_id UUID NOT NULL REFERENCES employees(id),
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  issuer TEXT,
  issued_on DATE,
  expires_on DATE,
  outcome TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS employee_certifications_site_employee ON employee_certifications(site_id, employee_id);
CREATE INDEX IF NOT EXISTS employee_certifications_site_expires ON employee_certifications(site_id, expires_on);
