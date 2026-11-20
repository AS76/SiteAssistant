import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { openTestDb } from './helpers/db.mjs';
import { authFixture } from './helpers/auth.mjs';
import { createSite, createTask, getTask, transitionTask } from '../server/repository.mjs';
import { recogniseResponsibles, parseArgs, formatSummary, runCli } from '../server/recognise-responsibles.mjs';
import { taskPayload } from '../app/domain.mjs';
import { createApi } from '../app/api.mjs';
import { messages } from '../app/i18n.mjs';

async function fixture(t) {
  const database = await openTestDb();
  t.after(database.close);
  const { db } = database;
  const site = await createSite(db, { code: 'RESPONSIBLES', name: 'Synthetic responsible site' });
  const { users } = await authFixture(db, site);
  const task = input => createTask(db, { siteId: site.id, title: 'Synthetic task', executor: 'External team', verifier: 'External reviewer', ...input });
  return { db, site, users, task };
}

test('recognition previews without writes, links unique normalised names, and is idempotent', async t => {
  const { db, site, users, task } = await fixture(t);
  const matched = await task({ executor: '  EXAMPLE   EDITOR ', verifier: 'example\tVERIFIER' });
  const unmatched = await task({});
  const before = await getTask(db, matched.id);
  const preview = await recogniseResponsibles(db, site.id);
  assert.deepEqual(preview, { matched: 2, unmatched: 2, ambiguous: 0, linked: 0, ambiguities: [] });
  assert.deepEqual(await getTask(db, matched.id), before);
  const applied = await recogniseResponsibles(db, site.id, { apply: true });
  assert.equal(applied.linked, 2);
  assert.deepEqual(await getTask(db, matched.id), { ...before, executor_id: users.editor.id, verifier_id: users.verifier.id });
  assert.deepEqual(await getTask(db, unmatched.id), unmatched);
  const second = await recogniseResponsibles(db, site.id, { apply: true });
  assert.deepEqual(second, { matched: 0, unmatched: 2, ambiguous: 0, linked: 0, ambiguities: [] });
});

test('recognition reports duplicate names without choosing a member, even across different roles', async t => {
  const { db, site, users, task } = await fixture(t);
  await db.run('UPDATE users SET name = ? WHERE id = ? OR id = ?', 'Shared synthetic member', users.verifier.id, users.viewer.id);
  const ambiguous = await task({ verifier: ' SHARED  synthetic MEMBER ' });
  const result = await recogniseResponsibles(db, site.id, { apply: true });
  assert.equal(result.matched, 0);
  assert.equal(result.unmatched, 1);
  assert.equal(result.ambiguous, 1);
  assert.equal(result.linked, 0);
  assert.equal(result.ambiguities[0].task_id, ambiguous.id);
  assert.equal(result.ambiguities[0].field, 'verifier');
  assert.deepEqual(new Set(result.ambiguities[0].candidates.map(row => row.user_id)), new Set([users.verifier.id, users.viewer.id]));
  assert.match(formatSummary(result), /ambiguous: 1\nAmbiguous:/);
  assert.doesNotMatch(formatSummary(result), /email|password|hash|@/i);
  assert.deepEqual(await getTask(db, ambiguous.id), ambiguous);
  assert.equal((await recogniseResponsibles(db, site.id, { apply: true })).linked, 0);
});

test('recognition excludes disabled members, respects assignment roles and preserves existing links', async t => {
  const { db, site, users, task } = await fixture(t);
  const linked = await task({ executor: 'Name snapshot', executor_id: users.editor.id,
    verifier: users.verifier.name, verifier_id: users.verifier.id });
  await db.run('UPDATE users SET disabled_at = ? WHERE id = ?', new Date().toISOString(), users.verifier.id);
  const disabled = await task({ executor: users.verifier.name, verifier: users.editor.name });
  const viewer = await task({ executor: users.viewer.name });
  const other = await createSite(db, { code: 'OTHER-RESPONSIBLES', name: 'Other synthetic site' });
  const outside = await createTask(db, { siteId: other.id, title: 'Other task', executor: users.editor.name, verifier: users.owner.name });
  const result = await recogniseResponsibles(db, site.id, { apply: true });
  assert.deepEqual(result, { matched: 0, unmatched: 4, ambiguous: 0, linked: 0, ambiguities: [] });
  for (const row of [linked, disabled, viewer, outside]) assert.deepEqual(await getTask(db, row.id), row);
  await assert.rejects(recogniseResponsibles(db, randomUUID()), error => error.status === 404);
});

test('recognition refuses to link the same identity twice, including against an existing link', async t => {
  const { db, site, users, task } = await fixture(t);
  const both = await task({ executor: ' EXAMPLE OWNER ', verifier: users.owner.name });
  const partial = await task({ executor: 'Old snapshot', executor_id: users.owner.id, verifier: users.owner.name });
  const result = await recogniseResponsibles(db, site.id, { apply: true });
  assert.equal(result.matched, 0);
  assert.equal(result.ambiguous, 3);
  assert.ok(result.ambiguities.every(row => row.reason === 'same_person'));
  assert.deepEqual(await getTask(db, both.id), both);
  assert.deepEqual(await getTask(db, partial.id), partial);
});

test('recognition can fill one missing link without changing submission identity or history', async t => {
  const { db, site, users, task } = await fixture(t);
  const created = await task({ executor: ' EXAMPLE EDITOR ', verifier: users.verifier.name, verifier_id: users.verifier.id });
  await transitionTask(db, created.id, { to: 'in_progress' }, users.editor);
  const before = await transitionTask(db, created.id, { to: 'to_verify', note: 'Synthetic evidence' }, users.editor);
  const result = await recogniseResponsibles(db, site.id, { apply: true });
  assert.equal(result.linked, 1);
  assert.deepEqual(await getTask(db, created.id), { ...before, executor_id: users.editor.id });
});

test('recognition rolls back earlier links if an update fails', async t => {
  const { db, site, users, task } = await fixture(t);
  const first = await task({ executor: users.editor.name });
  const second = await task({ executor: users.editor.name });
  let writes = 0;
  const failingDb = { transaction: callback => db.transaction(tx => callback({ ...tx,
    run: async (sql, ...params) => {
      if (sql.startsWith('UPDATE tasks') && ++writes === 2) throw new Error('Synthetic update failure');
      return await tx.run(sql, ...params);
    },
  })) };
  await assert.rejects(recogniseResponsibles(failingDb, site.id, { apply: true }), /Synthetic update failure/);
  assert.equal(writes, 2);
  assert.deepEqual(await getTask(db, first.id), first);
  assert.deepEqual(await getTask(db, second.id), second);
});

test('manual CLI validates flags before opening storage and returns zero with nothing to link', async t => {
  assert.deepEqual(parseArgs(['--apply', '--site', 'synthetic-site']), { siteId: 'synthetic-site', apply: true });
  for (const args of [[], ['--site'], ['--site', '--apply'], ['--site', ' '], ['--unknown'],
    ['--site', 'id', '--apply', '--apply'], ['--site', 'id', '--site', 'other']]) assert.throws(() => parseArgs(args));
  let opened = false, error = '';
  assert.equal(await runCli([], { openStorage: () => { opened = true; }, stderr: { write: text => { error += text; } } }), 2);
  assert.equal(opened, false);
  assert.match(error, /--site/);
  const { db, site } = await fixture(t);
  let closed = 0, output = '';
  for (const flags of [[], ['--apply']]) {
    assert.equal(await runCli(['--site', site.id, ...flags], {
      openStorage: async () => ({ transaction: callback => db.transaction(callback), close: async () => { closed++; } }),
      stdout: { write: text => { output += text; } }, stderr: { write: text => assert.fail(text) },
    }), 0);
  }
  assert.equal(closed, 2);
  assert.match(output, /Dry run .*no changes/);
  assert.match(output, /matched: 0\nunmatched: 0\nambiguous: 0\nlinked: 0/);
});

test('task client carries account IDs and omits IDs for free names', async () => {
  const input = { siteId: 'synthetic-site', title: 'Synthetic task', assignee: 'Synthetic executor', reviewer: 'Synthetic reviewer' };
  const ids = { executor_id: randomUUID(), verifier_id: randomUUID() };
  let body;
  const api = createApi({ fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body); return Response.json({ id: 'synthetic-task', ...body });
  } });
  await api.createTask({ ...input, ...ids });
  assert.equal(body.executor_id, ids.executor_id);
  assert.equal(body.verifier_id, ids.verifier_id);
  for (const extra of [{}, { executor_id: '', verifier_id: '' }, { executor_id: null, verifier_id: null }]) {
    await api.createTask({ ...input, ...extra });
    assert.equal(Object.hasOwn(body, 'executor_id'), false);
    assert.equal(Object.hasOwn(body, 'verifier_id'), false);
  }
  assert.throws(() => taskPayload({ ...input, executor_id: ids.executor_id, verifier_id: ids.executor_id }), /separatePeople/);
});

test('assignable client encodes the site ID and uses credentialed fresh reads', async () => {
  let requested;
  const rows = [{ user_id: randomUUID(), name: 'Synthetic member', role: 'editor' }];
  const api = createApi({ baseUrl: '/', fresh: true, fetchImpl: async (url, options) => {
    requested = { url, options }; return Response.json(rows);
  } });
  assert.deepEqual(await api.listAssignable('site /?&'), rows);
  assert.deepEqual(requested, { url: '/api/sites/site%20%2F%3F%26/assignable', options: { credentials: 'include', cache: 'reload' } });
});

// Exercise the real form wiring with only the DOM controls substituted.
async function formFixture(language = 'it') {
  const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
  const controls = {};
  for (const [key, name] of [['executor', 'assignee'], ['verifier', 'reviewer']]) {
    const select = { value: '', options: [{ value: '' }, { value: 'other' }],
      addEventListener(_event, handler) { this.change = handler; },
      remove(index) { this.options.splice(index, 1); }, add(option, index) { this.options.splice(index, 0, option); } };
    controls[key] = { select, name: { value: '', type: 'hidden' }, id: { value: '' }, free: { hidden: true }, nameKey: name };
  }
  const form = { elements: Object.fromEntries(Object.entries(controls).flatMap(([key, control]) =>
    [[control.nameKey, control.name], [`${key}_id`, control.id]])),
  querySelector(selector) {
    const key = selector.includes('executor') ? 'executor' : 'verifier';
    return selector.includes('data-free-name') ? controls[key].free : controls[key].select;
  } };
  const context = { document: { createElement: () => ({}) }, t: key => messages[language][key],
    esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;') };
  runInNewContext(source.slice(source.indexOf('function taskResponsibleFields()'), source.indexOf('async function showTaskForm()')), context);
  const setMembers = context.wireTaskResponsibles(form);
  const choose = (key, value) => { controls[key].select.value = value; controls[key].select.change(); };
  return { controls, setMembers, choose, html: context.taskResponsibleFields() };
}

test('task form offers members with translated roles, filters reviewers and prevents duplicate selection', async () => {
  const { controls, setMembers, choose, html } = await formFixture();
  const members = ['editor', 'owner', 'verifier'].map(role => ({ user_id: randomUUID(), name: `Synthetic <${role}>`, role }));
  setMembers(members);
  assert.match(html, /Altra persona…/);
  assert.match(html, /aria-describedby="responsible-separate"/);
  assert.equal(controls.executor.select.options.length, 5);
  assert.equal(controls.verifier.select.options.length, 4);
  assert.equal(controls.executor.select.options[1].textContent, 'Synthetic <editor> (Editor)');
  choose('executor', members[0].user_id);
  assert.equal(controls.executor.id.value, members[0].user_id);
  assert.equal(controls.executor.name.value, members[0].name);
  assert.equal(controls.executor.free.hidden, true);
  choose('verifier', members[1].user_id);
  assert.equal(controls.verifier.id.value, members[1].user_id);
  choose('executor', members[1].user_id);
  assert.equal(controls.verifier.select.value, '');
  assert.equal(controls.verifier.id.value, '');
  const disabled = controls.verifier.select.options.find(option => option.value === members[1].user_id);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.title, messages.it.responsibleSeparate);
  choose('executor', members[0].user_id);
  assert.equal(disabled.disabled, false);
});

test('task form preserves free names during loading and clears account IDs when switching to free text', async () => {
  const { controls, setMembers, choose } = await formFixture('en');
  choose('executor', 'other');
  controls.executor.name.value = 'Synthetic external crew';
  const member = { user_id: randomUUID(), name: 'Synthetic owner', role: 'owner' };
  setMembers([member]);
  assert.equal(controls.executor.name.value, 'Synthetic external crew');
  assert.equal(controls.executor.free.hidden, false);
  assert.equal(controls.executor.name.type, 'text');
  assert.equal(controls.executor.id.value, '');
  choose('verifier', member.user_id);
  assert.equal(controls.verifier.name.value, member.name);
  assert.equal(controls.verifier.id.value, member.user_id);
  choose('verifier', 'other');
  controls.verifier.name.value = 'Synthetic external reviewer';
  assert.equal(controls.verifier.id.value, '');
  assert.equal(controls.verifier.free.hidden, false);
});

test('responsible form labels are available in Italian and English', () => {
  for (const key of ['responsibleChoose', 'responsibleOther', 'responsibleName', 'responsibleSeparate',
    'responsibleRole_owner', 'responsibleRole_editor', 'responsibleRole_verifier', 'assignableUnavailable']) {
    for (const language of ['it', 'en']) assert.equal(typeof messages[language][key], 'string', `${language}: ${key}`);
  }
});
