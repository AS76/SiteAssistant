import { randomUUID } from 'node:crypto';
import { hashPassword } from './auth.mjs';
import { openDb, closeDb } from './db.mjs';
import { listSites, createTask } from './repository.mjs';

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
    // Raw insert on the columns every schema version has: seed must also run against older
    // migrations, where the jurisdiction column does not exist yet and its database default applies.
    const demoSite = async (code, name, location, start_date, end_date) => {
      const id = randomUUID();
      await tx.run(`INSERT INTO sites (id, code, name, location, start_date, end_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, id, code, name, location, start_date, end_date,
      new Date().toISOString());
      return { id, code, name };
    };
    const first = await demoSite('FITT-01', 'Cantiere dimostrativo Borgo Nuvolario',
      'Comune immaginario di Nuvolario, area A', '2026-11-01', '2026-12-20');
    const second = await demoSite('FITT-02', 'Cantiere dimostrativo Ponte dei Sogni Blu',
      'Comune immaginario di Sognalba, area B', '2026-11-02', '2026-12-22');
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
    await tx.run(`INSERT INTO diary (id, site_id, operational_date, shift, plan, actual, impediments, next_step, created_at)
      VALUES (?, ?, '2026-11-06', 'day', ?, ?, ?, ?, ?)`, randomUUID(), first.id,
    'Preparare il percorso di prova.', 'Percorso dimostrativo predisposto.', 'Nessun impedimento nella simulazione.',
    'Controllare il supporto campione.', new Date().toISOString());
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
