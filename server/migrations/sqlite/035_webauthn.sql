CREATE TABLE webauthn_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  sign_count BIGINT NOT NULL CHECK (sign_count >= 0),
  transports TEXT NOT NULL,
  aaguid TEXT,
  name TEXT NOT NULL,
  attestation_type TEXT,
  backup_eligible INTEGER NOT NULL,
  backup_state INTEGER NOT NULL,
  user_verified INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX webauthn_credentials_user ON webauthn_credentials(user_id);
CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('registration', 'authentication')),
  challenge_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE auth_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT,
  event TEXT NOT NULL,
  outcome TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE sessions ADD COLUMN auth_method TEXT;
ALTER TABLE sessions ADD COLUMN assurance TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
ALTER TABLE sessions ADD COLUMN credential_id TEXT;
CREATE TRIGGER auth_events_no_update BEFORE UPDATE ON auth_events BEGIN SELECT RAISE(ABORT, 'auth_events is append-only'); END;
CREATE TRIGGER auth_events_no_delete BEFORE DELETE ON auth_events BEGIN SELECT RAISE(ABORT, 'auth_events is append-only'); END;
