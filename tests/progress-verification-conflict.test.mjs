import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createServer } from '../server/http.mjs';
import { assignProgressType, createProgressType, setStepProgress } from '../server/progress-types.mjs';
import { createSite } from '../server/repository.mjs';
import { createWbs } from '../server/wbs.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { wbsDatabase } from './helpers/wbs.mjs';

for (const driver of ['sqlite', 'pg']) test(`progress verification conflict in list and detail (${driver})`, async t => {
  const db = await wbsDatabase(t, driver);
  const site = await createSite(db, { code: 'SYN-A', name: 'Synthetic site A' });
  const foreignSite = await createSite(db, { code: 'SYN-B', name: 'Synthetic site B' });
  const { users, cookies } = await authFixture(db, site);
  await db.run("INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, 'owner')", foreignSite.id, users.owner.id);
  const node = (code, siteId = site.id) => createWbs(db, { site_id: siteId, wbs_code: code }, users.owner);
  const matching = await node('A.1');
  const closed = await node('A.2');
  const other = await node('A.3');
  const foreign = await node('A.3', foreignSite.id);
  const at = '2026-01-15T08:00:00Z';
  const addTask = async (status, wbsId, siteId = site.id) => {
    const id = randomUUID();
    await db.run(`INSERT INTO tasks (id, site_id, wbs_id, title, executor, verifier, status, created_at,
      submitted_by, acceptance_state) VALUES (?, ?, ?, 'Synthetic task', 'Synthetic executor',
      'Synthetic verifier', ?, ?, 'Synthetic executor', 'declared')`, id, siteId, wbsId, status, at);
    return id;
  };
  const openTask = await addTask('to_verify', matching.id);
  await addTask('closed', closed.id);
  await addTask('to_verify', null);
  await addTask('to_verify', foreign.id, foreignSite.id);

  const cases = [
    { label: 'matching review', wbsId: matching.id, pct: 100, count: 1, conflict: true },
    { label: 'closed review with declared acceptance', wbsId: closed.id, pct: 100, count: 0, conflict: false, legacyCount: 1 },
    { label: 'partial progress', wbsId: matching.id, pct: 80, count: 1, conflict: false },
    { label: 'missing WBS', wbsId: null, pct: 100, count: 0, conflict: false },
    { label: 'review only on other nodes', wbsId: other.id, pct: 100, count: 0, conflict: false },
    { label: 'more than 100 percent', wbsId: matching.id, pct: 101, count: 1, conflict: false },
    { label: 'weighted steps at 100 percent', wbsId: matching.id, pct: 80, effective: 100, count: 1, conflict: true },
  ];
  for (const [index, example] of cases.entries()) {
    example.id = randomUUID();
    await db.run(`INSERT INTO site_progress_items (id, site_id, wbs_id, description, progress_pct, source_row, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, example.id, site.id, example.wbsId, `Synthetic item ${index + 1}`, example.pct, index + 1, at);
  }
  const computed = cases.at(-1);
  const type = await createProgressType(db, { site_id: site.id, code: 'SYN', name: 'Synthetic progress type',
    steps: [{ code: 'S1', position: 1, weight: 60 }, { code: 'S2', position: 2, weight: 40 }] }, users.owner);
  await assignProgressType(db, computed.id, type.id, users.owner);
  await setStepProgress(db, computed.id, type.steps.map(step => ({ step_id: step.id, percent: 100 })), users.owner);

  const api = requestListener(createServer(db));
  const listUrl = `/api/site-progress?site_id=${site.id}`;
  const detailUrl = id => `/api/site-progress/${id}`;
  const read = async path => {
    const response = await api(path, { cookie: cookies.viewer });
    assert.equal(response.status, 200);
    return response.body;
  };
  const listed = await read(listUrl);
  assert.equal(listed.length, cases.length);
  for (const example of cases) await t.test(example.label, async () => {
    const { steps, ...detail } = await read(detailUrl(example.id));
    const listItem = listed.find(row => row.id === example.id);
    assert.deepEqual(listItem, detail, 'list and detail agree on item fields');
    assert.equal(steps.length, example.effective == null ? 0 : 2);
    assert.equal(detail.progress_pct, example.effective ?? example.pct);
    assert.equal(detail.verification_open_tasks, example.count);
    assert.equal(detail.verification_conflict, example.conflict);
    assert.equal(detail.open_verifications, example.legacyCount ?? example.count);
  });

  await t.test('closing the task clears the warning and preserves declared progress', async () => {
    const result = await api(`/api/tasks/${openTask}/transition`, { method: 'POST', cookie: cookies.owner,
      body: { to: 'closed', waiver: true, reason: 'Synthetic evidence waiver' } });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'closed');
    const [complete] = cases;
    for (const row of [(await read(listUrl)).find(row => row.id === complete.id), await read(detailUrl(complete.id))]) {
      assert.equal(row.progress_pct, 100);
      assert.equal(row.verification_open_tasks, 0);
      assert.equal(row.verification_conflict, false);
      assert.equal(row.open_verifications, 1);
    }
    const stored = await db.all('SELECT id, progress_pct FROM site_progress_items WHERE site_id = ?', site.id);
    assert.deepEqual(new Map(stored.map(row => [row.id, Number(row.progress_pct)])),
      new Map(cases.map(example => [example.id, example.pct])));
  });
});
