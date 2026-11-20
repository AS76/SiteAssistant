CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_algo TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disabled_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT,
  ip TEXT
);
CREATE TABLE IF NOT EXISTS site_members (
  site_id TEXT NOT NULL REFERENCES sites(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'verifier', 'viewer')),
  PRIMARY KEY (site_id, user_id)
);
CREATE INDEX IF NOT EXISTS site_members_user ON site_members (user_id);
ALTER TABLE tasks ADD COLUMN executor_id TEXT REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN verifier_id TEXT REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN submitted_by_id TEXT REFERENCES users(id);
