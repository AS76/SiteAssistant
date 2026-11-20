CREATE TABLE IF NOT EXISTS member_module_access (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  module TEXT NOT NULL,
  allowed BOOLEAN NOT NULL CHECK (allowed IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, user_id, module)
);
