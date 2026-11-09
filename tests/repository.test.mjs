import test from 'node:test';
import { isPg, openTestDb } from './helpers/db.mjs';
import {
  createSite, getSite, createTask, getTask, transitionTask, createDiary, listSites, listTasks, listDiary,
} from '../server/repository.mjs';
import { seed } from '../server/seed.mjs';

async function fixture(t) {
  const database = await openTestDb();
  const { db } = database;
  t.after(database.close);
  const site = await createSite(db, { code: 'FITT-REPO', name: 'Cantiere fittizio di Nebbialuna' });
  const task = await createTask(db, {
    siteId: site.id, title: 'Controllo dimostrativo',
    executor: 'Esecutore fittizio A', verifier: 'Verificatore fittizio B',
  });
  return { db, site, task };
}

test('repository enforces completion, verifier, reopening and preserves rejected transition history', async t => {
  const { db, task } = await fixture(t);
  const advance = (to, extra = {}) => transitionTask(db, task.id, { to, actor: task.executor, ...extra });
  await advance('in_progress');
  let before = await getTask(db, task.id);
  await t.assert.rejects(() => advance('to_verify'), { status: 400, code: 'NOTE_REQUIRED' });
  t.assert.deepStrictEqual(await getTask(db, task.id), before);
  await advance('to_verify', { note: 'Completamento simulato.' });
  before = await getTask(db, task.id);
  await t.assert.rejects(() => advance('closed', { note: 'Verifica simulata.' }), { status: 409, code: 'VERIFIER_REQUIRED' });
  await t.assert.rejects(() => advance('closed', { actor: task.verifier }), { status: 400, code: 'NOTE_REQUIRED' });
  t.assert.deepStrictEqual(await getTask(db, task.id), before);
  const closed = await advance('closed', { actor: task.verifier, note: 'Verifica simulata.' });
  await t.assert.rejects(() => advance('in_progress'), { status: 400, code: 'REASON_REQUIRED' });
  t.assert.deepStrictEqual(await getTask(db, task.id), closed);
  const reopened = await advance('in_progress', { actor: task.verifier, reason: 'Anomalia fittizia.' });
  t.assert.strictEqual(reopened.status, 'in_progress');
  t.assert.deepStrictEqual(reopened.events.slice(0, closed.events.length), closed.events);
});

test('repository rejects skipped edges and requires blocking reasons without writes', async t => {
  const { db, task } = await fixture(t);
  const before = await getTask(db, task.id);
  await t.assert.rejects(() => transitionTask(db, task.id, {
    to: 'closed', actor: task.verifier, note: 'Prova fittizia.',
  }), { status: 409, code: 'INVALID_TRANSITION' });
  await t.assert.rejects(() => transitionTask(db, task.id, {
    to: 'blocked', actor: task.executor, reason: '  ',
  }), { status: 400, code: 'REASON_REQUIRED' });
  t.assert.deepStrictEqual(await getTask(db, task.id), before);
  const blocked = await transitionTask(db, task.id, {
    to: 'blocked', actor: task.executor, reason: 'Materiale campione assente.',
  });
  t.assert.strictEqual(blocked.status, 'blocked');
  t.assert.strictEqual(blocked.events.at(-1).reason, 'Materiale campione assente.');
});

test('SQLite transition transaction rolls back the status if event insertion fails', async t => {
  if (isPg) { t.skip('Uses a SQLite RAISE trigger.'); return; }
  const { db, task } = await fixture(t);
  const before = await getTask(db, task.id);
  await db.exec(`CREATE TRIGGER fail_event BEFORE INSERT ON task_events
    BEGIN SELECT RAISE(ABORT, 'Synthetic event failure'); END;`);
  await t.assert.rejects(() => transitionTask(db, task.id, {
    to: 'in_progress', actor: task.executor,
  }), /Synthetic event failure/);
  t.assert.deepStrictEqual(await getTask(db, task.id), before);
});

test('creation has one atomic todo-to-todo event with an explicit or default actor', async t => {
  const { db, site, task } = await fixture(t);
  t.assert.strictEqual(task.events.length, 1);
  const event = task.events[0];
  t.assert.strictEqual(event.action, 'create');
  t.assert.strictEqual(event.from_status, 'todo');
  t.assert.strictEqual(event.to_status, 'todo');
  t.assert.strictEqual(event.actor, task.executor);
  t.assert.strictEqual(event.at, task.created_at);
  const created = await createTask(db, {
    siteId: site.id, title: 'Example', executor: 'Executor', verifier: 'Verifier', actor: 'Creator',
  });
  t.assert.strictEqual(created.events[0].actor, 'Creator');
  await db.exec(isPg ? `
    CREATE FUNCTION fail_create() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Synthetic creation failure'; END; $$;
    CREATE TRIGGER fail_create BEFORE INSERT ON task_events
      FOR EACH ROW EXECUTE FUNCTION fail_create();
  ` : `CREATE TRIGGER fail_create BEFORE INSERT ON task_events
    BEGIN SELECT RAISE(ABORT, 'Synthetic creation failure'); END;`);
  const before = await listTasks(db);
  await t.assert.rejects(() => createTask(db, {
    siteId: site.id, title: 'Rollback example', executor: 'Executor', verifier: 'Verifier',
  }), /Synthetic creation failure/);
  t.assert.deepStrictEqual(await listTasks(db), before);
});

test('block and resume restore each open state and retain the original submitter', async t => {
  for (const state of ['todo', 'in_progress', 'to_verify']) {
    const { db, task } = await fixture(t);
    const advance = (to, extra = {}) => transitionTask(db, task.id, { to, actor: task.executor, ...extra });
    if (state !== 'todo') await advance('in_progress');
    if (state === 'to_verify') await advance('to_verify', { note: 'Example evidence' });
    const blocked = await advance('blocked', { reason: 'Example blocker' });
    t.assert.strictEqual(blocked.blocked_from, state);
    t.assert.strictEqual(blocked.events.at(-1).action, 'block');
    await t.assert.rejects(() => advance('closed', { note: 'Example' }), { status: 409, code: 'INVALID_TRANSITION' });
    const resumed = await advance(state, { actor: task.verifier });
    t.assert.strictEqual(resumed.status, state);
    t.assert.strictEqual(resumed.blocked_from, null);
    t.assert.strictEqual(resumed.submitted_by, state === 'to_verify' ? task.executor : null);
    t.assert.strictEqual(resumed.events.at(-1).action, 'resume');
    t.assert.strictEqual(resumed.events.at(-1).from_status, 'blocked');
    t.assert.strictEqual(resumed.events.at(-1).to_status, state);
    await advance('blocked', { reason: 'Another blocker' });
    for (const invalid of [null, '', 'unknown', 'blocked', 'closed']) {
      await db.run('UPDATE tasks SET blocked_from = ? WHERE id = ?', invalid, task.id);
      const before = await getTask(db, task.id);
      await t.assert.rejects(() => advance(state), { status: 409, code: 'INVALID_TRANSITION' });
      t.assert.deepStrictEqual(await getTask(db, task.id), before);
    }
  }
});

test('reject requires a note and a different actor; reopen requires verifier or simulated owner', async t => {
  const { db, task } = await fixture(t);
  const advance = (to, extra = {}) => transitionTask(db, task.id, { to, actor: task.executor, ...extra });
  const started = await advance('in_progress');
  t.assert.strictEqual(started.events.at(-1).action, 'start');
  const submitted = await advance('to_verify', { actor: 'Example submitter', note: 'Evidence' });
  t.assert.strictEqual(submitted.submitted_by, 'Example submitter');
  t.assert.strictEqual(submitted.events.at(-1).action, 'submit');
  await t.assert.rejects(() => advance('in_progress'), { status: 400, code: 'NOTE_REQUIRED' });
  await t.assert.rejects(() => advance('in_progress', { actor: 'Example submitter', note: 'Example' }), {
    status: 409, code: 'INVALID_TRANSITION',
  });
  t.assert.deepStrictEqual(await getTask(db, task.id), submitted);
  const rejected = await advance('in_progress', { note: 'Correction required' });
  t.assert.strictEqual(rejected.events.at(-1).action, 'reject');
  t.assert.strictEqual(rejected.events.at(-1).note, 'Correction required');
  for (const actor of [task.verifier, 'owner']) {
    const resubmitted = await advance('to_verify', { note: 'Corrected evidence' });
    t.assert.strictEqual(resubmitted.submitted_by, task.executor);
    const closed = await advance('closed', { actor: task.verifier, note: 'Checked' });
    t.assert.strictEqual(closed.events.at(-1).action, 'verify');
    await t.assert.rejects(() => advance('in_progress', { reason: 'Example' }), {
      status: 409, code: 'INVALID_TRANSITION',
    });
    t.assert.deepStrictEqual(await getTask(db, task.id), closed);
    const reopened = await advance('in_progress', { actor, reason: 'Follow-up' });
    t.assert.strictEqual(reopened.events.at(-1).action, 'reopen');
  }
});

test('repository validates site/task data and rejects duplicate site and diary keys', async t => {
  const { db, site, task } = await fixture(t);
  await t.assert.rejects(() => createSite(db, { code: 'FITT-REPO', name: 'Cantiere fittizio' }), {
    status: 409, code: 'DUPLICATE_SITE_CODE',
  });
  await t.assert.rejects(() => createSite(db, { code: 'FITT-ALTRO', name: 'Cantiere fittizio', start_date: '2026-02-30' }), {
    status: 400, code: 'VALIDATION_ERROR',
  });
  await t.assert.rejects(() => createSite(db, {
    code: 'FITT-ALTRO', name: 'Cantiere fittizio', start_date: '2026-11-06', end_date: '2026-11-01',
  }), { status: 400, code: 'VALIDATION_ERROR' });
  await t.assert.rejects(() => createTask(db, {
    siteId: site.id, title: 'Prova fittizia', executor: 'Demo', verifier: ' Demo ',
  }), { status: 400, code: 'SEPARATE_PEOPLE_REQUIRED' });
  await t.assert.rejects(() => getTask(db, 'unknown'), { status: 404, code: 'TASK_NOT_FOUND' });
  await t.assert.rejects(() => getSite(db, 'unknown'), { status: 404, code: 'SITE_NOT_FOUND' });
  t.assert.deepStrictEqual(await listTasks(db, { siteId: 'unknown' }), []);
  t.assert.deepStrictEqual(await listDiary(db, { siteId: 'unknown' }), []);
  const input = { siteId: site.id, operational_date: '2026-11-06', shift: 'day' };
  const entry = await createDiary(db, input);
  await t.assert.rejects(() => createDiary(db, input), { status: 409, code: 'DUPLICATE_DIARY' });
  await createDiary(db, { ...input, shift: 'night' });
  t.assert.strictEqual((await listDiary(db)).length, 2);
  t.assert.strictEqual(entry.operational_date, input.operational_date);
  t.assert.strictEqual((await listSites(db)).length, 1);
  t.assert.deepStrictEqual((await listTasks(db, { siteId: site.id, status: 'todo' })).map(row => row.id), [task.id]);
  await t.test('SQLite enables foreign keys', async t => {
    if (isPg) { t.skip('PRAGMA is SQLite-specific.'); return; }
    t.assert.strictEqual((await db.get('PRAGMA foreign_keys')).foreign_keys, 1);
  });
  await t.assert.rejects(() => db.run(`UPDATE tasks SET site_id = '00000000-0000-4000-8000-000000000000' WHERE id = ?`, task.id), /foreign key/i);
  await t.assert.rejects(() => db.run(`UPDATE tasks SET status = 'unknown' WHERE id = ?`, task.id), /check/i);
});

test('seed is atomic and idempotent, and leaves existing user data alone', async t => {
  if (isPg) { t.skip('Uses a SQLite RAISE trigger.'); return; }
  const database = await openTestDb();
  const { db } = database;
  t.after(database.close);
  await db.exec(`CREATE TRIGGER fail_diary BEFORE INSERT ON diary
    BEGIN SELECT RAISE(ABORT, 'Synthetic diary failure'); END;`);
  await t.assert.rejects(() => seed(db), /Synthetic diary failure/);
  t.assert.strictEqual((await listSites(db)).length, 0);
  t.assert.strictEqual((await listTasks(db)).length, 0);
  await db.exec('DROP TRIGGER fail_diary');
  t.assert.strictEqual(await seed(db), true);
  t.assert.strictEqual(await seed(db), false);
  t.assert.strictEqual((await listSites(db)).length, 2);
  t.assert.strictEqual((await listTasks(db)).length, 4);
  t.assert.strictEqual((await listDiary(db)).length, 1);

  const existing = await fixture(t);
  t.assert.strictEqual(await seed(existing.db), false);
  t.assert.strictEqual((await listSites(existing.db)).length, 1);
  t.assert.strictEqual((await listTasks(existing.db)).length, 1);
  t.assert.strictEqual((await listDiary(existing.db)).length, 0);
});
