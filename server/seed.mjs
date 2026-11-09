import { randomUUID } from 'node:crypto';
import { hashPassword } from './auth.mjs';
import { openDb, closeDb } from './db.mjs';
import { listSites, createSite, createTask, createDiary } from './repository.mjs';

// All labels and identities below are invented demo data, not real entities.
export async function seed(db, { reset = false, environment = process.env.NODE_ENV || 'development' } = {}) {
  if (!['development', 'test', 'staging'].includes(environment)) {
    throw new Error('Synthetic credentials may only be seeded in development, test or staging.');
  }
  return await db.transaction(async tx => {
    if (reset) {
      for (const table of ['idempotency_keys', 'task_events', 'tasks', 'diary', 'site_members', 'sessions', 'users', 'sites']) {
        await tx.run(`DELETE FROM ${table}`);
      }
    }
    if ((await listSites(tx)).length || await tx.get('SELECT id FROM users LIMIT 1')) return false;
    const users = {};
    for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
      const user = { id: randomUUID(), name: `Demo ${role}` };
      await tx.run(`INSERT INTO users (id, email, name, password_hash, password_algo, created_at)
        VALUES (?, ?, ?, ?, 'scrypt', ?)`, user.id, `${role}@example.invalid`, user.name,
      await hashPassword(`Local-${role}-5b!`), new Date().toISOString());
      users[role] = user;
    }
    const first = await createSite(tx, {
      code: 'FITT-01', name: 'Cantiere dimostrativo Borgo Nuvolario',
      location: 'Comune immaginario di Nuvolario, area A',
      start_date: '2026-11-01', end_date: '2026-12-20',
    });
    const second = await createSite(tx, {
      code: 'FITT-02', name: 'Cantiere dimostrativo Ponte dei Sogni Blu',
      location: 'Comune immaginario di Sognalba, area B',
      start_date: '2026-11-02', end_date: '2026-12-22',
    });
    for (const site of [first, second]) {
      for (const [role, user] of Object.entries(users)) {
        await tx.run('INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, ?)', site.id, user.id, role);
      }
    }
    for (const [siteId, title, area, priority] of [
      [first.id, 'Predisporre il percorso dimostrativo', 'Zona A', 'normal'],
      [first.id, 'Controllare il supporto campione', 'Zona B', 'high'],
      [second.id, 'Preparare il materiale di prova', 'Zona C', 'normal'],
      [second.id, 'Annotare le misure simulate', 'Zona D', 'normal'],
    ]) {
      await createTask(tx, {
        siteId, title, area, priority, company: 'Impresa fittizia Mattoni di Nebbia',
        executor: users.editor.name, verifier: users.verifier.name,
        executor_id: users.editor.id, verifier_id: users.verifier.id, actor: users.owner.name, due_date: '2026-11-20',
      });
    }
    await createDiary(tx, {
      siteId: first.id, operational_date: '2026-11-06', shift: 'day',
      plan: 'Preparare il percorso di prova.', actual: 'Percorso dimostrativo predisposto.',
      impediments: 'Nessun impedimento nella simulazione.', next_step: 'Controllare il supporto campione.',
    });
    return true;
  });
}

if (import.meta.main) {
  if (process.env.NODE_ENV === 'production') throw new Error('Synthetic seed is disabled in production.');
  const db = await openDb();
  try {
    console.log(await seed(db, { reset: process.argv.includes('--reset') }) ? 'Inserted 4 fictional users, 2 sites, 4 tasks and 1 diary entry.' : 'Seed skipped: data already exists.');
  } finally {
    await closeDb(db);
  }
}
