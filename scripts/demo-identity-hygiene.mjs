#!/usr/bin/env node
// Demo identity hygiene: keep real accounts out of demo memberships.
// Dry-run by default. Never deletes users, never changes passwords.
import { openDb, closeDb } from '../server/db.mjs';

const DEMO_SITE = "(s.code LIKE 'FITT-%' OR s.code LIKE 'NL-%')";
const SYNTHETIC_EMAIL = /\.(invalid|example)$/i;

export const isSyntheticEmail = email => SYNTHETIC_EMAIL.test(String(email || '').trim());

export function planHygiene(rows) {
  const byUser = new Map();
  for (const row of rows) {
    if (isSyntheticEmail(row.email)) continue;
    const current = byUser.get(row.user_id) || { userId: row.user_id, memberships: [] };
    current.memberships.push({ siteCode: row.site_code, role: row.role });
    byUser.set(row.user_id, current);
  }
  return [...byUser.values()].map((item, index) => ({ ...item, label: `account-${index + 1}` }));
}

export function sitesMissingSyntheticOwner(rows, plan) {
  const ownedSites = new Set(rows
    .filter(row => row.role === 'owner' && row.disabled_at == null && isSyntheticEmail(row.email))
    .map(row => row.site_code));
  const affectedSites = new Set(plan.flatMap(item => item.memberships.map(membership => membership.siteCode)));
  return [...affectedSites].filter(siteCode => !ownedSites.has(siteCode));
}

export function confirmPhrase(argv) {
  let phrase = null;
  for (const [index, arg] of argv.entries()) {
    const separate = arg === '--confirm';
    if (!separate && !arg.startsWith('--confirm=')) continue;
    const value = separate ? argv[index + 1] : arg.slice('--confirm='.length);
    if (!value || (separate && value.startsWith('--'))) return null;
    if (phrase !== null && phrase !== value) return null;
    phrase = value;
  }
  return phrase;
}

function masked(label) { return label; }

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (apply && confirmPhrase(args) !== 'demo-identity-hygiene') {
    throw new Error('Apply requires --confirm demo-identity-hygiene.');
  }
  const db = await openDb(undefined, { migrate: false });
  try {
    const rows = await db.all(`SELECT u.id AS user_id, u.email, u.disabled_at, s.id AS site_id, s.code AS site_code, m.role
      FROM users u JOIN site_members m ON m.user_id = u.id JOIN sites s ON s.id = m.site_id
      WHERE ${DEMO_SITE} ORDER BY u.id, s.code`);
    const plan = planHygiene(rows);
    console.log(`Non-synthetic demo accounts: ${plan.length}`);
    console.log(`Memberships to remove: ${plan.reduce((sum, item) => sum + item.memberships.length, 0)}`);
    for (const item of plan) console.log(`- ${masked(item.label)}: ${item.memberships.map(m => `${m.siteCode}:${m.role}`).join(', ')}`);
    const missingOwners = sitesMissingSyntheticOwner(rows, plan);
    if (missingOwners.length) {
      throw new Error(`Active synthetic owner missing for demo sites ${missingOwners.join(', ')}. Refusing to remove demo memberships.`);
    }
    if (!apply) {
      console.log('Dry-run only. Re-run with --apply --confirm demo-identity-hygiene to remove these demo memberships.');
      return;
    }
    const siteIdsByCode = new Map(rows.map(row => [row.site_code, row.site_id]));
    let removed = 0;
    await db.transaction(async tx => {
      for (const item of plan) {
        for (const membership of item.memberships) {
          const result = await tx.run('DELETE FROM site_members WHERE user_id = ? AND site_id = ?',
            item.userId, siteIdsByCode.get(membership.siteCode));
          removed += Number(result?.rowCount ?? 0);
        }
      }
    });
    console.log(`Removed demo memberships: ${removed}. Users and passwords were not changed.`);
  } finally {
    await closeDb(db);
  }
}

if (import.meta.main) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
