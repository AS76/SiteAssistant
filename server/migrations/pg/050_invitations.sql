CREATE TABLE user_permissions (
  user_id UUID NOT NULL REFERENCES users(id),
  permission TEXT NOT NULL CHECK (permission = 'invitations.manage'),
  granted_by UUID REFERENCES users(id),
  granted_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX user_permissions_active ON user_permissions (user_id, permission)
  WHERE revoked_at IS NULL;

CREATE TABLE invitations (
  id UUID PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('it', 'en')),
  site_id UUID REFERENCES sites(id) ON DELETE SET NULL,
  site_role TEXT CHECK (site_role IN ('owner', 'editor', 'verifier', 'viewer')),
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'failed')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  delivered_at TIMESTAMPTZ,
  last_delivery_error TEXT
);
CREATE UNIQUE INDEX invitations_pending_email ON invitations (email)
  WHERE used_at IS NULL AND revoked_at IS NULL;
