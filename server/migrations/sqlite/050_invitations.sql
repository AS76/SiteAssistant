CREATE TABLE user_permissions (
  user_id TEXT NOT NULL REFERENCES users(id),
  permission TEXT NOT NULL CHECK (permission = 'invitations.manage'),
  granted_by TEXT REFERENCES users(id),
  granted_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX user_permissions_active ON user_permissions (user_id, permission)
  WHERE revoked_at IS NULL;

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
  site_role TEXT CHECK (site_role IN ('owner', 'editor', 'verifier', 'viewer')),
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'failed')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  delivered_at TEXT,
  last_delivery_error TEXT
);
CREATE UNIQUE INDEX invitations_pending_email ON invitations (email)
  WHERE used_at IS NULL AND revoked_at IS NULL;
