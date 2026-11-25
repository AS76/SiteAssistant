ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1));

CREATE TABLE invitations (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT
);
CREATE UNIQUE INDEX invitations_pending_email ON invitations (email)
  WHERE used_at IS NULL AND revoked_at IS NULL;
