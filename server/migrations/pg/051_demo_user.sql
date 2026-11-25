ALTER TABLE sites ADD COLUMN demo_sandbox BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN demo_sandbox BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE site_members DROP CONSTRAINT site_members_role_check;
ALTER TABLE site_members ADD CONSTRAINT site_members_role_check
  CHECK (role IN ('owner', 'editor', 'verifier', 'viewer', 'demo_user'));
ALTER TABLE invitations DROP CONSTRAINT invitations_site_role_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_site_role_check
  CHECK (site_role IN ('owner', 'editor', 'verifier', 'viewer', 'demo_user'));

CREATE VIEW accessible_site_members AS
SELECT m.site_id, m.user_id, m.role
FROM site_members m JOIN users u ON u.id = m.user_id JOIN sites s ON s.id = m.site_id
WHERE (NOT u.demo_sandbox AND m.role <> 'demo_user')
   OR (u.demo_sandbox AND s.demo_sandbox AND m.role <> 'owner');
