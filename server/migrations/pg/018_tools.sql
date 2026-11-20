CREATE TABLE IF NOT EXISTS tools (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  name TEXT NOT NULL,
  code TEXT,
  company TEXT,
  status TEXT NOT NULL CHECK (status IN ('available', 'in_use', 'maintenance', 'retired')),
  location TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS tools_site_company ON tools(site_id, company);
