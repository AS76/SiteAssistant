import { openDb, closeDb } from './db.mjs';
import { listSites, createSite, createTask, createDiary } from './repository.mjs';

// All labels and identities below are invented demo data, not real entities.
export async function seed(db) {
  return await db.transaction(async tx => {
    if ((await listSites(tx)).length) return false;
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
    for (const [siteId, title, area, priority] of [
      [first.id, 'Predisporre il percorso dimostrativo', 'Zona A', 'normal'],
      [first.id, 'Controllare il supporto campione', 'Zona B', 'high'],
      [second.id, 'Preparare il materiale di prova', 'Zona C', 'normal'],
      [second.id, 'Annotare le misure simulate', 'Zona D', 'normal'],
    ]) {
      await createTask(tx, {
        siteId, title, area, priority, company: 'Impresa fittizia Mattoni di Nebbia',
        executor: 'Operatore fittizio A', verifier: 'Verificatore fittizio B', due_date: '2026-11-20',
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
  const db = await openDb();
  try {
    console.log(await seed(db) ? 'Inserted 2 fictional sites, 4 tasks and 1 diary entry.' : 'Seed skipped: data already exists.');
  } finally {
    await closeDb(db);
  }
}
