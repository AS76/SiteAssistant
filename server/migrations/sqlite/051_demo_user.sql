ALTER TABLE sites ADD COLUMN demo_sandbox BOOLEAN NOT NULL DEFAULT FALSE CHECK (demo_sandbox IN (0, 1));
ALTER TABLE users ADD COLUMN demo_sandbox BOOLEAN NOT NULL DEFAULT FALSE CHECK (demo_sandbox IN (0, 1));

ALTER TABLE site_members RENAME TO site_members_before_demo_user;
DROP INDEX site_members_user;
CREATE TABLE site_members (
  site_id TEXT NOT NULL REFERENCES sites(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'verifier', 'viewer', 'demo_user')),
  PRIMARY KEY (site_id, user_id)
);
INSERT INTO site_members (site_id, user_id, role)
SELECT site_id, user_id, role FROM site_members_before_demo_user;
DROP TABLE site_members_before_demo_user;
CREATE INDEX site_members_user ON site_members (user_id);

ALTER TABLE invitations RENAME TO invitations_before_demo_user;
DROP INDEX invitations_pending_email;
CREATE TABLE invitations (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('it', 'en')),
  site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
  site_role TEXT CHECK (site_role IN ('owner', 'editor', 'verifier', 'viewer', 'demo_user')),
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'failed')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  delivered_at TEXT,
  last_delivery_error TEXT
);
INSERT INTO invitations (id, email, token_hash, created_by, created_at, expires_at, used_at, revoked_at,
  locale, site_id, site_role, delivery_status, delivery_attempts, delivered_at, last_delivery_error)
SELECT id, email, token_hash, created_by, created_at, expires_at, used_at, revoked_at,
  locale, site_id, site_role, delivery_status, delivery_attempts, delivered_at, last_delivery_error FROM invitations_before_demo_user;
DROP TABLE invitations_before_demo_user;
CREATE UNIQUE INDEX invitations_pending_email ON invitations (email)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE VIEW accessible_site_members AS
SELECT m.site_id, m.user_id, m.role
FROM site_members m JOIN users u ON u.id = m.user_id JOIN sites s ON s.id = m.site_id
WHERE (NOT u.demo_sandbox AND m.role <> 'demo_user')
   OR (u.demo_sandbox AND s.demo_sandbox AND m.role <> 'owner');
