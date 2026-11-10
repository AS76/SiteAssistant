import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSite } from '../server/repository.mjs';
import { listCostImpacts, getCostImpact, createCostImpact, transitionCostImpact } from '../server/cost-impacts.mjs';
import { createServer } from '../server/http.mjs';
import { migrate, applyMigration } from '../server/migrations/index.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { isPg, openTestDb, openSqliteTestDb } from './helpers/db.mjs';
import { wbsDatabase } from './helpers/wbs.mjs';

for (const driver of ['sqlite', 'pg']) test(`Cost impacts ${driver}: writable claims, transitions and access`, async t => {
  let db;
  if (driver === 'pg' && !isPg) db = await wbsDatabase(t, driver);
  else {
    const database = await (driver === 'sqlite' ? openSqliteTestDb() : openTestDb());
    db = database.db; t.after(database.close);
  }
  const auth = await authFixture(db), api = requestListener(createServer(db));
  const fixture = async () => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic claim site' });
    for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
      await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, auth.users[role].id, role);
    }
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) await db.run(`INSERT INTO deviations (id, site_id, title, status, created_at)
      VALUES (?, ?, 'Synthetic deviation', 'open', ?)`, id, site.id, '2026-01-15T08:00:00.000Z');
    return { site, ids, input: { site_id: site.id, title: 'Synthetic claim', deviation_ids: ids, claim_amount: '1234.50' } };
  };
  const create = input => createCostImpact(db, input, auth.users.editor);
  const transition = (id, input, role = 'owner') => transitionCostImpact(db, id, input, auth.users[role]);
  const request = (path, role = 'viewer', options = {}) => api(path, { cookie: auth.cookies[role], ...options });
  const post = (body, role = 'editor') => request('/api/cost-impacts', role, { method: 'POST', body });
  const move = (id, body, role = 'owner') => request(`/api/cost-impacts/${id}/transition`, role, { method: 'POST', body });
  const error = (response, status, code) => {
    t.assert.strictEqual(response.status, status); t.assert.strictEqual(response.body.code, code);
  };

  await t.test('create, list, detail and full lifecycle preserve linked deviations and nullable amounts', async t => {
    const f = await fixture(), other = await fixture();
    const sourceBefore = await db.all('SELECT * FROM deviations WHERE site_id = ? ORDER BY id', f.site.id);
    const response = await post({ ...f.input, site_id: f.site.id.toUpperCase(),
      deviation_ids: [...f.ids.map(id => id.toUpperCase()), f.ids[0]], created_by: auth.users.owner.id });
    t.assert.strictEqual(response.status, 201);
    const row = response.body;
    t.assert.strictEqual(row.status, 'open'); t.assert.strictEqual(row.site_id, f.site.id);
    t.assert.strictEqual(row.created_by, auth.users.editor.id);
    t.assert.strictEqual(Number(row.claim_amount), 1234.5);
    for (const field of ['settlement_amount', 'result', 'closed_at']) t.assert.strictEqual(row[field], null);
    t.assert.deepStrictEqual(row.deviations.map(d => d.id), [...f.ids].sort());
    t.assert.ok(Number.isFinite(Date.parse(row.created_at)));
    const detail = await request(`/api/cost-impacts/${row.id.toUpperCase()}`);
    t.assert.strictEqual(detail.status, 200); t.assert.deepStrictEqual(detail.body, row);
    await create(other.input);
    const listed = await request(`/api/cost-impacts?site_id=${f.site.id.toUpperCase()}&status=open`);
    t.assert.strictEqual(listed.status, 200); t.assert.deepStrictEqual(listed.body.map(r => r.id), [row.id]);
    for (const [to, role] of [['notification_sent', 'owner'], ['submitted', 'verifier']]) {
      const moved = await move(row.id, { to }, role);
      t.assert.strictEqual(moved.status, 200); t.assert.strictEqual(moved.body.status, to);
      t.assert.strictEqual(moved.body.closed_at, null); t.assert.strictEqual(moved.body.result, null);
    }
    const closed = await move(row.id, { to: 'closed', result: 'settled', settlement_amount: '1000.25' }, 'verifier');
    t.assert.strictEqual(closed.status, 200); t.assert.strictEqual(closed.body.status, 'closed');
    t.assert.strictEqual(closed.body.result, 'settled'); t.assert.strictEqual(Number(closed.body.settlement_amount), 1000.25);
    t.assert.ok(Number.isFinite(Date.parse(closed.body.closed_at)));
    t.assert.strictEqual(closed.body.created_at, row.created_at);
    t.assert.deepStrictEqual(await listCostImpacts(db, { siteId: f.site.id, status: 'open' }), []);
    t.assert.strictEqual((await listCostImpacts(db, { siteId: f.site.id, status: 'closed' })).length, 1);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM deviations WHERE site_id = ? ORDER BY id', f.site.id), sourceBefore);
  });

  await t.test('all transition pairs enforce the directed graph, including terminal closure', async t => {
    const f = await fixture();
    const graph = { open: ['notification_sent', 'closed'], notification_sent: ['submitted'], submitted: ['closed'], closed: [] };
    for (const from of Object.keys(graph)) for (const to of Object.keys(graph)) {
      const row = await create(f.input);
      await db.run('UPDATE cost_impacts SET status = ?, result = ?, closed_at = ? WHERE id = ?',
        from, from === 'closed' ? 'dropped' : null, from === 'closed' ? '2026-01-15T08:00:00.000Z' : null, row.id);
      const before = await getCostImpact(db, row.id);
      const input = { to, ...(to === 'closed' ? { result: 'rejected' } : {}) };
      if (graph[from].includes(to)) t.assert.strictEqual((await transition(row.id, input)).status, to);
      else {
        await t.assert.rejects(() => transition(row.id, input), { status: 409, code: 'INVALID_TRANSITION' });
        t.assert.deepStrictEqual(await getCostImpact(db, row.id), before);
      }
    }
  });

  await t.test('closure requires a valid result; every outcome supports direct closure', async t => {
    const f = await fixture(), row = await create(f.input);
    for (const result of [undefined, null, '', 'unknown', 'SETTLED', 42]) {
      error(await move(row.id, { to: 'closed', result }), 400, 'VALIDATION_ERROR');
    }
    error(await move(row.id, { to: 'notification_sent', result: 'settled' }), 400, 'VALIDATION_ERROR');
    t.assert.strictEqual((await getCostImpact(db, row.id)).status, 'open');
    for (const result of ['settled', 'dropped', 'rejected']) {
      const claim = await create(f.input);
      const closed = await transition(claim.id, { to: 'closed', result, settlement_amount: 0 });
      t.assert.strictEqual(closed.result, result); t.assert.strictEqual(Number(closed.settlement_amount), 0);
    }
  });

  await t.test('validation covers creation, states, filters, amounts and missing IDs', async t => {
    const f = await fixture(), row = await create({ ...f.input, claim_amount: null });
    t.assert.strictEqual(row.claim_amount, null);
    for (const title of ['', '  ', null, 42]) error(await post({ ...f.input, title }), 400, 'VALIDATION_ERROR');
    for (const deviation_ids of [undefined, [], null, 'invalid', ['invalid'], [null]]) {
      error(await post({ ...f.input, deviation_ids }), 400, 'VALIDATION_ERROR');
    }
    for (const status of ['notification_sent', 'submitted', 'closed', 'unknown', '', null]) {
      error(await post({ ...f.input, status }), 400, 'VALIDATION_ERROR');
    }
    for (const extra of [{ result: 'settled' }, { closed_at: '2026-01-15T08:00:00Z' }]) {
      error(await post({ ...f.input, ...extra }), 400, 'VALIDATION_ERROR');
    }
    for (const field of ['claim_amount', 'settlement_amount']) {
      for (const value of ['', 'NaN', 'Infinity', '1,20', true, [], {}, NaN, Infinity]) {
        await t.assert.rejects(() => create({ ...f.input, [field]: value }), { status: 400, code: 'VALIDATION_ERROR' });
        await t.assert.rejects(() => transition(row.id, { to: 'closed', result: 'settled', [field]: value }),
          { status: 400, code: 'VALIDATION_ERROR' });
      }
    }
    for (const to of [undefined, null, 'unknown', 'OPEN', '']) error(await move(row.id, { to }), 400, 'VALIDATION_ERROR');
    for (const path of ['/api/cost-impacts', '/api/cost-impacts?site_id=invalid',
      `/api/cost-impacts?site_id=${f.site.id}&status=`, `/api/cost-impacts?site_id=${f.site.id}&status=unknown`]) {
      error(await request(path), 400, 'VALIDATION_ERROR');
    }
    for (const id of [undefined, '', 'invalid', 42]) {
      await t.assert.rejects(() => listCostImpacts(db, { siteId: id }), { status: 400, code: 'VALIDATION_ERROR' });
      error(await post({ ...f.input, site_id: id }), 400, 'VALIDATION_ERROR');
    }
    error(await request(`/api/cost-impacts?site_id=${randomUUID()}`), 404, 'SITE_NOT_FOUND');
    for (const id of ['invalid', randomUUID()]) {
      error(await request(`/api/cost-impacts/${id}`), 404, 'COST_IMPACT_NOT_FOUND');
      error(await move(id, { to: 'closed', result: 'settled' }), 404, 'COST_IMPACT_NOT_FOUND');
    }
    // PostgreSQL retains exact decimal strings; SQLite uses its native NUMERIC affinity.
    const precise = await create({ ...f.input, claim_amount: '12345678901234567890.123456789', settlement_amount: -1.25 });
    if (driver === 'pg') t.assert.strictEqual(precise.claim_amount, '12345678901234567890.123456789');
    t.assert.strictEqual(Number(precise.settlement_amount), -1.25);
  });

  await t.test('same-site links are required and failed writes leave no partial claim or links', async t => {
    const f = await fixture(), other = await fixture();
    const counts = async () => [await db.get('SELECT COUNT(*) AS n FROM cost_impacts'),
      await db.get('SELECT COUNT(*) AS n FROM cost_impact_deviations')];
    const before = await counts();
    error(await post({ ...f.input, deviation_ids: [f.ids[0], other.ids[0]] }), 409, 'COST_IMPACT_SITE_MISMATCH');
    error(await post({ ...f.input, deviation_ids: [f.ids[0], randomUUID()] }), 404, 'DEVIATION_NOT_FOUND');
    t.assert.deepStrictEqual(await counts(), before);
    const failing = { transaction: fn => db.transaction(tx => fn({ ...tx, run: async (sql, ...args) => {
      const result = await tx.run(sql, ...args);
      if (sql.startsWith('INSERT INTO cost_impact_deviations')) throw new Error('Synthetic link failure');
      return result;
    } })) };
    await t.assert.rejects(() => createCostImpact(failing, f.input, auth.users.editor), /Synthetic link failure/);
    t.assert.deepStrictEqual(await counts(), before);
  });

  await t.test('auth and site membership protect every HTTP route and direct mutations', async t => {
    const f = await fixture(), row = await create(f.input);
    const routes = [
      [`/api/cost-impacts?site_id=${f.site.id}`, {}], [`/api/cost-impacts/${row.id}`, {}],
      ['/api/cost-impacts', { method: 'POST', body: f.input }],
      [`/api/cost-impacts/${row.id}/transition`, { method: 'POST', body: { to: 'closed', result: 'settled' } }],
    ];
    for (const [path, options] of routes) error(await api(path, options), 401, 'AUTH_REQUIRED');
    await t.assert.rejects(() => createCostImpact(db, f.input), { status: 401, code: 'UNAUTHENTICATED' });
    await t.assert.rejects(() => transitionCostImpact(db, row.id, { to: 'closed', result: 'settled' }),
      { status: 401, code: 'UNAUTHENTICATED' });
    error(await post(f.input, 'viewer'), 403, 'FORBIDDEN');
    await t.assert.rejects(() => createCostImpact(db, f.input, auth.users.viewer), { status: 403, code: 'FORBIDDEN' });
    for (const role of ['editor', 'viewer']) for (const to of ['notification_sent', 'closed']) {
      error(await move(row.id, { to, ...(to === 'closed' ? { result: 'settled' } : {}) }, role), 403, 'FORBIDDEN');
      await t.assert.rejects(() => transition(row.id, { to, result: 'settled' }, role), { status: 403, code: 'FORBIDDEN' });
    }
    for (const role of ['owner', 'editor', 'verifier']) t.assert.strictEqual((await post(f.input, role)).status, 201);
    for (const role of ['owner', 'verifier']) {
      const claim = await create(f.input);
      t.assert.strictEqual((await move(claim.id, { to: 'closed', result: 'dropped' }, role)).status, 200);
    }
    for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
      await db.run('DELETE FROM site_members WHERE site_id = ? AND user_id = ?', f.site.id, auth.users[role].id);
      for (const [path, options] of routes) error(await request(path, role, options), 403, 'FORBIDDEN');
      await t.assert.rejects(() => createCostImpact(db, f.input, auth.users[role]), { status: 403, code: 'FORBIDDEN' });
      await t.assert.rejects(() => transition(row.id, { to: 'closed', result: 'settled' }, role), { status: 403, code: 'FORBIDDEN' });
    }
  });

  await t.test('competing closures have one winner and preserve the winner result', async t => {
    const f = await fixture(), row = await create(f.input);
    const attempts = await Promise.allSettled(['settled', 'rejected'].map(result =>
      transition(row.id, { to: 'closed', result })));
    const winners = attempts.filter(a => a.status === 'fulfilled'), losers = attempts.filter(a => a.status === 'rejected');
    t.assert.strictEqual(winners.length, 1); t.assert.strictEqual(losers.length, 1);
    t.assert.strictEqual(losers[0].reason.status, 409);
    t.assert.strictEqual((await getCostImpact(db, row.id)).result, winners[0].value.result);
  });

  await t.test('migration replay preserves claims; SQL enforces enums, closure result, FKs and unique links', async t => {
    const f = await fixture(), row = await create(f.input);
    const before = await getCostImpact(db, row.id);
    t.assert.strictEqual(await migrate(db, { driver }), 0);
    await applyMigration(db, '013_cost_impacts.sql', { driver });
    t.assert.deepStrictEqual(await getCostImpact(db, row.id), before);
    for (const [field, value, pattern] of [['site_id', randomUUID(), /foreign key/i], ['created_by', randomUUID(), /foreign key/i],
      ['status', 'unknown', /check/i], ['result', 'unknown', /check/i], ['status', 'closed', /check/i],
      ['title', null, /not.null/i], ['created_at', null, /not.null/i]]) {
      await t.assert.rejects(() => db.run(`UPDATE cost_impacts SET ${field} = ? WHERE id = ?`, value, row.id), pattern);
    }
    for (const [claimId, deviationId, pattern] of [[randomUUID(), f.ids[0], /foreign key/i],
      [row.id, randomUUID(), /foreign key/i], [row.id, f.ids[0], /unique/i]]) {
      await t.assert.rejects(() => db.run('INSERT INTO cost_impact_deviations VALUES (?, ?)', claimId, deviationId), pattern);
    }
    await t.assert.rejects(() => db.run('DELETE FROM deviations WHERE id = ?', f.ids[0]), /foreign key/i);
    await t.assert.rejects(() => db.run('DELETE FROM cost_impacts WHERE id = ?', row.id), /foreign key/i);
    if (driver === 'pg') {
      const columns = await db.all("SELECT column_name, udt_name FROM information_schema.columns WHERE table_name = 'cost_impacts' AND table_schema = current_schema()");
      for (const [field, type] of [['id', 'uuid'], ['site_id', 'uuid'], ['created_by', 'uuid'],
        ['created_at', 'timestamptz'], ['closed_at', 'timestamptz'], ['claim_amount', 'numeric'], ['settlement_amount', 'numeric']]) {
        t.assert.strictEqual(columns.find(c => c.column_name === field).udt_name, type);
      }
    } else {
      const columns = await db.all('PRAGMA table_info(cost_impacts)');
      for (const field of ['claim_amount', 'settlement_amount']) t.assert.strictEqual(columns.find(c => c.name === field).type, 'NUMERIC');
    }
  });
});
