ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE invitations (
  id UUID PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX invitations_pending_email ON invitations (email)
  WHERE used_at IS NULL AND revoked_at IS NULL;
