export function isDemoSandbox(env = process.env) {
  const environment = env.APP_ENV || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || env.NODE_ENV;
  return environment?.trim().toLowerCase() === 'demo';
}

export async function demoteDemoOwners(db, userId) {
  await db.run(`UPDATE site_members SET role = 'demo_user'
    WHERE role = 'owner' AND site_id IN (SELECT id FROM sites WHERE demo_sandbox)
      AND user_id IN (SELECT id FROM users WHERE demo_sandbox${userId === undefined ? '' : ' AND id = ?'})`,
  ...(userId === undefined ? [] : [userId]));
}

export async function migrateDemoSandbox(db) {
  await db.run('UPDATE sites SET demo_sandbox = TRUE WHERE NOT demo_sandbox');
  await db.run(`UPDATE users SET demo_sandbox = TRUE WHERE shared_demo AND NOT demo_sandbox
    AND id IN (SELECT user_id FROM site_members WHERE role = 'owner')`);
  await demoteDemoOwners(db);
}
