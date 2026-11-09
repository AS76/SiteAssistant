import test from 'node:test';
import { isPg, openTestDb, openSqliteTestDb } from './helpers/db.mjs';
import {
  createSite, createTask, getTask, transitionTask, createDiary, listSites, listTasks, listDiary,
} from '../server/repository.mjs';

async function fixture(t, open = openTestDb) {
  const database = await open();
  t.after(database.close);
  const site = await createSite(database.db, {
    code: 'FITT-PARITY', name: 'Cantiere fittizio', location: 'Area dimostrativa',
    start_date: '2026-11-01', end_date: '2026-11-30',
  });
  const task = await createTask(database.db, {
    siteId: site.id, title: 'Controllo fittizio', area: 'Area A', company: 'Impresa demo',
    executor: 'Esecutore demo', verifier: 'Verificatore demo', priority: 'high', due_date: '2026-11-10',
  });
  return { db: database.db, site, task };
}

async function scenario(t, open) {
  const { db, site, task } = await fixture(t, open);
  const results = [site, task];
  const advance = (to, extra = {}) => transitionTask(db, task.id, {
    to, actor: task.executor, ...extra,
  });
  const reject = async (operation, expected) => {
    const before = await getTask(db, task.id);
    await t.assert.rejects(operation, error => {
      t.assert.strictEqual(error.status, expected.status);
      t.assert.strictEqual(error.code, expected.code);
      results.push({ status: error.status, error: error.message, code: error.code });
      return true;
    });
    t.assert.deepStrictEqual(await getTask(db, task.id), before);
  };

  await reject(() => createSite(db, { code: site.code, name: site.name }), {
    status: 409, code: 'DUPLICATE_SITE_CODE',
  });
  await reject(() => advance('closed', { actor: task.verifier, note: 'Verifica demo.' }), {
    status: 409, code: 'INVALID_TRANSITION',
  });
  results.push(await advance('in_progress'));
  await reject(() => advance('to_verify'), { status: 400, code: 'NOTE_REQUIRED' });
  results.push(await advance('to_verify', { note: 'Completamento demo.' }));
  await reject(() => advance('closed', { note: 'Verifica demo.' }), {
    status: 409, code: 'VERIFIER_REQUIRED',
  });
  results.push(await advance('closed', { actor: task.verifier, note: 'Verifica demo.' }));
  await reject(() => advance('in_progress'), { status: 400, code: 'REASON_REQUIRED' });
  results.push(await advance('in_progress', { actor: task.verifier, reason: 'Riapertura demo.' }));
  await reject(() => advance('blocked'), { status: 400, code: 'REASON_REQUIRED' });
  const blocked = await advance('blocked', { reason: 'Impedimento demo.' });
  results.push(blocked);
  t.assert.strictEqual(blocked.events.length, 6);
  for (const event of blocked.events) t.assert.strictEqual(typeof event.id, 'number');
  await reject(() => advance('todo'), { status: 409, code: 'INVALID_TRANSITION' });
  results.push(await advance('in_progress'));

  const diaryInput = {
    siteId: site.id, operational_date: '2026-11-06', shift: 'day',
    plan: 'Piano demo.', actual: 'Attività demo.', impediments: 'Impedimento demo.', next_step: 'Verifica demo.',
  };
  const diary = await createDiary(db, diaryInput);
  results.push(diary);
  await reject(() => createDiary(db, diaryInput), { status: 409, code: 'DUPLICATE_DIARY' });
  results.push(await listSites(db), await listTasks(db, { siteId: site.id }),
    await listDiary(db, { siteId: site.id }), await getTask(db, task.id));

  // UUIDs are server-generated independently in each run. Canonicalize only
  // these three values (and references), preserving every other value/type.
  const ids = new Map([[site.id, '<site>'], [task.id, '<task>'], [diary.id, '<diary>']]);
  t.assert.strictEqual(ids.size, 3);
  for (const id of ids.keys()) {
    t.assert.strictEqual(typeof id, 'string');
    t.assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  return JSON.stringify(results, (key, value) => {
    if (ids.has(value)) return ids.get(value);
    // JSON field order is not part of the HTTP contract.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    }
    return value;
  });
}

test('repository parity sequence preserves serialized results, errors and JSON types', async t => {
  // Keep generated timestamps identical; UUIDs alone are canonicalized above.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T12:00:00.000Z') });
  const sqlite = await scenario(t, openSqliteTestDb);
  await t.test('pg matches the SQLite serialization', {
    skip: !isPg && 'Cross-driver parity runs with DB_DRIVER=pg and DATABASE_URL_TEST.',
  }, async t => {
    const pg = await scenario(t, openTestDb);
    t.assert.strictEqual(pg, sqlite);
  });
});

test('concurrent transitions commit exactly one status change and one numeric-ID event', async t => {
  const { db, task } = await fixture(t);
  let racingDb = db;
  if (isPg) {
    // Force both pg transactions to read todo before either can update it.
    // SQLite already serializes transactions on its single connection.
    let readers = 0;
    let release;
    const bothRead = new Promise(resolve => { release = resolve; });
    racingDb = {
      transaction: fn => db.transaction(tx => fn({
        ...tx,
        get: async (sql, ...params) => {
          const row = await tx.get(sql, ...params);
          if (sql === 'SELECT * FROM tasks WHERE id = ?' && row?.status === 'todo') {
            readers += 1;
            if (readers === 2) release();
            await bothRead;
          }
          return row;
        },
      })),
    };
  }
  const results = await Promise.allSettled([
    transitionTask(racingDb, task.id, { to: 'in_progress', actor: task.executor }),
    transitionTask(racingDb, task.id, { to: 'in_progress', actor: task.executor }),
  ]);
  const successes = results.filter(result => result.status === 'fulfilled');
  const failures = results.filter(result => result.status === 'rejected');
  t.assert.strictEqual(successes.length, 1);
  t.assert.strictEqual(failures.length, 1);
  t.assert.strictEqual(failures[0].reason.status, 409);
  t.assert.strictEqual(failures[0].reason.code, 'INVALID_TRANSITION');
  const current = await getTask(db, task.id);
  t.assert.strictEqual(current.status, 'in_progress');
  t.assert.strictEqual(current.events.length, 2);
  t.assert.strictEqual(typeof current.events[0].id, 'number');
  t.assert.strictEqual(typeof successes[0].value.events[0].id, 'number');
  t.assert.strictEqual(current.events.at(-1).from_status, 'todo');
  t.assert.strictEqual(current.events.at(-1).to_status, 'in_progress');
  t.assert.deepStrictEqual(current, successes[0].value);
});

test('pg rolls back the status when a BEFORE INSERT task_events trigger raises', async t => {
  if (!isPg) { t.skip('Uses a PostgreSQL RAISE EXCEPTION trigger.'); return; }
  const { db, task } = await fixture(t);
  const before = await getTask(db, task.id);
  // The fixture confines this function, trigger and all data to its test schema.
  await db.exec(`
    CREATE FUNCTION fail_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'Synthetic event failure';
    END;
    $$;
    CREATE TRIGGER fail_event BEFORE INSERT ON task_events
      FOR EACH ROW EXECUTE FUNCTION fail_event();
  `);
  await t.assert.rejects(() => transitionTask(db, task.id, {
    to: 'in_progress', actor: task.executor,
  }), /Synthetic event failure/);
  t.assert.deepStrictEqual(await getTask(db, task.id), before);
});
