ALTER TABLE users ADD COLUMN password_change_required BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS signup_requests (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  decision_token_hash TEXT NOT NULL UNIQUE,
  completion_token_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS signup_requests_email_status ON signup_requests (email, status);
CREATE UNIQUE INDEX IF NOT EXISTS signup_requests_pending_email ON signup_requests (lower(email)) WHERE status = 'pending';
