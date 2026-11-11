CREATE TABLE IF NOT EXISTS employee_certifications (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  issuer TEXT,
  issued_on TEXT,
  expires_on TEXT,
  outcome TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS employee_certifications_site_employee ON employee_certifications(site_id, employee_id);
CREATE INDEX IF NOT EXISTS employee_certifications_site_expires ON employee_certifications(site_id, expires_on);
