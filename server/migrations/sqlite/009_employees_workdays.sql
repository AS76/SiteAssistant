-- Read-only application projections; ingestion remains separately provisioned.
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  employee_no TEXT NOT NULL,
  first_name TEXT, last_name TEXT,
  company TEXT, qualification TEXT, supervisor TEXT, team TEXT,
  hire_date TEXT, expire_date TEXT,
  source_entity_key_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (site_id, employee_no)
);
CREATE TABLE IF NOT EXISTS work_days (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  employee_id TEXT REFERENCES employees(id),
  operational_date TEXT NOT NULL,
  shift TEXT CHECK (shift IN ('day', 'night')),
  start_time TEXT, finish_time TEXT,
  work_time NUMERIC, open_hours NUMERIC, booked_hours NUMERIC,
  source_status TEXT,
  source_entity_key_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_days_employee_date ON work_days(site_id, employee_id, operational_date);

-- Trusted site/scope/run binding, never inferred from names or accepted over HTTP.
CREATE TABLE IF NOT EXISTS hr_import_sources (
  site_id TEXT PRIMARY KEY NOT NULL REFERENCES sites(id),
  scope_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  promoted_run_id TEXT,
  promoted_employees_batch_id TEXT,
  promoted_work_days_batch_id TEXT,
  promoted_at TEXT
);
