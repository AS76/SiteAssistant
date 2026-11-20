-- Read-only application projections; ingestion remains separately provisioned.
CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  employee_no TEXT NOT NULL,
  first_name TEXT, last_name TEXT,
  company TEXT, qualification TEXT, supervisor TEXT, team TEXT,
  hire_date DATE, expire_date DATE,
  source_entity_key_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (site_id, employee_no)
);
CREATE TABLE IF NOT EXISTS work_days (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  employee_id UUID REFERENCES employees(id),
  operational_date DATE NOT NULL,
  shift TEXT CHECK (shift IN ('day', 'night')),
  start_time TIME, finish_time TIME,
  work_time NUMERIC, open_hours NUMERIC, booked_hours NUMERIC,
  source_status TEXT,
  source_entity_key_id UUID,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS work_days_employee_date ON work_days(site_id, employee_id, operational_date);

-- Trusted site/scope/run binding, never inferred from names or accepted over HTTP.
CREATE TABLE IF NOT EXISTS hr_import_sources (
  site_id UUID PRIMARY KEY NOT NULL REFERENCES sites(id),
  scope_id UUID NOT NULL,
  run_id UUID NOT NULL,
  promoted_run_id UUID,
  promoted_employees_batch_id UUID,
  promoted_work_days_batch_id UUID,
  promoted_at TIMESTAMPTZ
);
