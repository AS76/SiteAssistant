ALTER TABLE users ADD COLUMN IF NOT EXISTS password_change_required BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS signup_requests (
  id UUID PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  decision_token_hash TEXT NOT NULL UNIQUE,
  completion_token_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS signup_requests_email_status ON signup_requests (email, status);
CREATE UNIQUE INDEX IF NOT EXISTS signup_requests_pending_email ON signup_requests (lower(email)) WHERE status = 'pending';
