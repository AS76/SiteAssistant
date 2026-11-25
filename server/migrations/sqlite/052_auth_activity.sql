ALTER TABLE sessions ADD COLUMN expiry_logged_at TEXT;

CREATE INDEX auth_events_login_at ON auth_events (created_at)
WHERE event IN ('login.success', 'login.failure');
