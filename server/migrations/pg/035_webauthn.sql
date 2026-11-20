CREATE TABLE webauthn_credentials (
  id UUID PRIMARY KEY NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key BYTEA NOT NULL,
  sign_count BIGINT NOT NULL CHECK (sign_count >= 0),
  transports TEXT NOT NULL,
  aaguid TEXT,
  name TEXT NOT NULL,
  attestation_type TEXT,
  backup_eligible BOOLEAN NOT NULL,
  backup_state BOOLEAN NOT NULL,
  user_verified BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ
);
CREATE INDEX webauthn_credentials_user ON webauthn_credentials(user_id);
CREATE TABLE webauthn_challenges (
  id UUID PRIMARY KEY NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('registration', 'authentication')),
  challenge_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE auth_events (
  id UUID PRIMARY KEY NOT NULL,
  user_id UUID,
  event TEXT NOT NULL,
  outcome TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  detail_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN auth_method TEXT;
ALTER TABLE sessions ADD COLUMN assurance TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN credential_id UUID;
CREATE FUNCTION auth_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'auth_events is append-only'; END;
$$;
CREATE TRIGGER auth_events_no_mutation BEFORE UPDATE OR DELETE ON auth_events
FOR EACH ROW EXECUTE FUNCTION auth_events_append_only();
CREATE TRIGGER auth_events_no_truncate BEFORE TRUNCATE ON auth_events
FOR EACH STATEMENT EXECUTE FUNCTION auth_events_append_only();
