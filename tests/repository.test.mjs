import test from 'node:test';
import { openDb, closeDb } from '../server/db.mjs';
import {
  createSite, createTask, getTask, transitionTask, createDiary, listSites, listTasks, listDiary,
} from '../server/repository.mjs';
import { seed } from '../server/seed.mjs';

function fixture(t) {
  const db = openDb(':memory:');
  t.after(() => closeDb(db));
  const site = createSite(db, { code: 'FITT-REPO', name: 'Cantiere fittizio di Nebbialuna' });
  const task = createTask(db, {
    siteId: site.id, title: 'Controllo dimostrativo',
    executor: 'Esecutore fittizio A', verifier: 'Verificatore fittizio B',
  });
  return { db, site, task };
}

test('repository enforces completion, verifier, reopening and preserves rejected transition history', t => {
  const { db, task } = fixture(t);
  const advance = (to, extra = {}) => transitionTask(db, task.id, { to, actor: task.executor, ...extra });
  advance('in_progress');
  let before = getTask(db, task.id);
  t.assert.throws(() => advance('to_verify'), { status: 400, code: 'NOTE_REQUIRED' });
  t.assert.deepStrictEqual(getTask(db, task.id), before);
  advance('to_verify', { note: 'Completamento simulato.' });
  before = getTask(db, task.id);
  t.assert.throws(() => advance('closed', { note: 'Verifica simulata.' }), { status: 409, code: 'VERIFIER_REQUIRED' });
  t.assert.throws(() => advance('closed', { actor: task.verifier }), { status: 400, code: 'NOTE_REQUIRED' });
  t.assert.deepStrictEqual(getTask(db, task.id), before);
  const closed = advance('closed', { actor: task.verifier, note: 'Verifica simulata.' });
  t.assert.throws(() => advance('in_progress'), { status: 400, code: 'REASON_REQUIRED' });
  t.assert.deepStrictEqual(getTask(db, task.id), closed);
  const reopened = advance('in_progress', { reason: 'Anomalia fittizia.' });
  t.assert.strictEqual(reopened.status, 'in_progress');
  t.assert.deepStrictEqual(reopened.events.slice(0, 3), closed.events);
});

test('repository rejects skipped edges and requires blocking reasons without writes', t => {
  const { db, task } = fixture(t);
  const before = getTask(db, task.id);
  t.assert.throws(() => transitionTask(db, task.id, {
    to: 'closed', actor: task.verifier, note: 'Prova fittizia.',
  }), { status: 409, code: 'INVALID_TRANSITION' });
  t.assert.throws(() => transitionTask(db, task.id, {
    to: 'blocked', actor: task.executor, reason: '  ',
  }), { status: 400, code: 'REASON_REQUIRED' });
  t.assert.deepStrictEqual(getTask(db, task.id), before);
  const blocked = transitionTask(db, task.id, {
    to: 'blocked', actor: task.executor, reason: 'Materiale campione assente.',
  });
  t.assert.strictEqual(blocked.status, 'blocked');
  t.assert.strictEqual(blocked.events[0].reason, 'Materiale campione assente.');
});

test('SQLite transition transaction rolls back the status if event insertion fails', t => {
  const { db, task } = fixture(t);
  const before = getTask(db, task.id);
  db.exec(`CREATE TRIGGER fail_event BEFORE INSERT ON task_events
    BEGIN SELECT RAISE(ABORT, 'Synthetic event failure'); END;`);
  t.assert.throws(() => transitionTask(db, task.id, {
    to: 'in_progress', actor: task.executor,
  }), /Synthetic event failure/);
  t.assert.deepStrictEqual(getTask(db, task.id), before);
});

test('repository validates site/task data and rejects duplicate site and diary keys', t => {
  const { db, site, task } = fixture(t);
  t.assert.throws(() => createSite(db, { code: 'FITT-REPO', name: 'Cantiere fittizio' }), {
    status: 409, code: 'DUPLICATE_SITE_CODE',
  });
  t.assert.throws(() => createSite(db, { code: 'FITT-ALTRO', name: 'Cantiere fittizio', start_date: '2026-02-30' }), {
    status: 400, code: 'VALIDATION_ERROR',
  });
  t.assert.throws(() => createSite(db, {
    code: 'FITT-ALTRO', name: 'Cantiere fittizio', start_date: '2026-11-06', end_date: '2026-11-01',
  }), { status: 400, code: 'VALIDATION_ERROR' });
  t.assert.throws(() => createTask(db, {
    siteId: site.id, title: 'Prova fittizia', executor: 'Demo', verifier: ' Demo ',
  }), { status: 400, code: 'SEPARATE_PEOPLE_REQUIRED' });
  t.assert.throws(() => getTask(db, 'unknown'), { status: 404, code: 'TASK_NOT_FOUND' });
  const input = { siteId: site.id, operational_date: '2026-11-06', shift: 'day' };
  const entry = createDiary(db, input);
  t.assert.throws(() => createDiary(db, input), { status: 409, code: 'DUPLICATE_DIARY' });
  createDiary(db, { ...input, shift: 'night' });
  t.assert.strictEqual(listDiary(db).length, 2);
  t.assert.strictEqual(entry.operational_date, input.operational_date);
  t.assert.strictEqual(listSites(db).length, 1);
  t.assert.deepStrictEqual(listTasks(db, { siteId: site.id, status: 'todo' }).map(row => row.id), [task.id]);
  t.assert.strictEqual(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  t.assert.throws(() => db.prepare(`UPDATE tasks SET site_id = 'unknown' WHERE id = ?`).run(task.id), /FOREIGN KEY/);
  t.assert.throws(() => db.prepare(`UPDATE tasks SET status = 'unknown' WHERE id = ?`).run(task.id), /CHECK/);
});

test('seed is atomic and idempotent, and leaves existing user data alone', t => {
  const db = openDb(':memory:');
  t.after(() => closeDb(db));
  db.exec(`CREATE TRIGGER fail_diary BEFORE INSERT ON diary
    BEGIN SELECT RAISE(ABORT, 'Synthetic diary failure'); END;`);
  t.assert.throws(() => seed(db), /Synthetic diary failure/);
  t.assert.strictEqual(listSites(db).length, 0);
  t.assert.strictEqual(listTasks(db).length, 0);
  db.exec('DROP TRIGGER fail_diary');
  t.assert.strictEqual(seed(db), true);
  t.assert.strictEqual(seed(db), false);
  t.assert.strictEqual(listSites(db).length, 2);
  t.assert.strictEqual(listTasks(db).length, 4);
  t.assert.strictEqual(listDiary(db).length, 1);

  const existing = fixture(t);
  t.assert.strictEqual(seed(existing.db), false);
  t.assert.strictEqual(listSites(existing.db).length, 1);
  t.assert.strictEqual(listTasks(existing.db).length, 1);
  t.assert.strictEqual(listDiary(existing.db).length, 0);
});
