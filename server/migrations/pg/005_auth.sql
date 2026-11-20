CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_algo TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  disabled_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  user_agent TEXT,
  ip TEXT
);
CREATE TABLE IF NOT EXISTS site_members (
  site_id UUID NOT NULL REFERENCES sites(id),
  user_id UUID NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'verifier', 'viewer')),
  PRIMARY KEY (site_id, user_id)
);
CREATE INDEX IF NOT EXISTS site_members_user ON site_members (user_id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS executor_id UUID REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verifier_id UUID REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS submitted_by_id UUID REFERENCES users(id);
