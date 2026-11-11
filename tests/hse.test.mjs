import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createSite } from '../server/repository.mjs';
import { createServer } from '../server/http.mjs';
import { HSE_TYPES, HSE_SEVERITIES, listHseEvents, createHseEvent, updateHseEvent, deleteHseEvent, hseSummary } from '../server/hse.mjs';
import { saveModuleAccess } from '../server/module-access.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { migrate, applyMigration } from '../server/migrations/index.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { isPg, openTestDb, openSqliteTestDb } from './helpers/db.mjs';

async function database(t, driver) {
  if (driver === 'sqlite' || isPg) {
    const fixture = await (driver === 'sqlite' ? openSqliteTestDb() : openTestDb());
    t.after(fixture.close);
    return fixture.db;
  }
  const pg = new PGlite();
  t.after(() => pg.close());
  const adapt = connection => ({
    exec: sql => connection.exec(sql),
    all: async (sql, ...values) => (await connection.query(translatePlaceholders(sql), values)).rows,
    get: async (sql, ...values) => (await connection.query(translatePlaceholders(sql), values)).rows[0],
    run: async (sql, ...values) => ({ rowCount: (await connection.query(translatePlaceholders(sql), values)).affectedRows }),
    isUniqueViolation: error => error.code === '23505',
  });
  const db = { ...adapt(pg), transaction: fn => pg.transaction(tx => fn(adapt(tx))) };
  await migrate(db, { driver });
  return db;
}

for (const driver of ['sqlite', 'pg']) test(`HSE register ${driver}`, async t => {
  const db = await database(t, driver);
  const { users, cookies } = await authFixture(db);
  const api = requestListener(createServer(db));
  const error = (status, code = 'HSE_INVALID') => ({ status, code });
  const fixture = async () => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic HSE site' });
    for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
      await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, users[role].id, role);
    }
    return {
      site,
      create: (input = {}, user = users.editor) => createHseEvent(db, {
        siteId: site.id, type: 'near_miss', severity: 'low', occurredOn: '2026-11-10', ...input,
      }, user),
      list: (filters = {}, user = users.editor) => listHseEvents(db, { siteId: site.id, ...filters }, user),
    };
  };
  const deviation = async site => {
    const id = randomUUID();
    await db.run(`INSERT INTO deviations (id, site_id, title, created_at) VALUES (?, ?, ?, ?)`,
      id, site.id, 'Synthetic barrier observation', new Date().toISOString());
    return id;
  };

  await t.test('required fields, optional nulls, normalisation and all types and severities', async t => {
    const f = await fixture();
    for (let i = 0; i < HSE_TYPES.length; i++) {
      const row = await f.create({ type: HSE_TYPES[i], severity: HSE_SEVERITIES[i], personsInvolved: i });
      t.assert.strictEqual(row.type, HSE_TYPES[i]);
      t.assert.strictEqual(row.severity, HSE_SEVERITIES[i]);
      t.assert.strictEqual(row.persons_involved, i);
      t.assert.strictEqual(row.occurred_on, '2026-11-10');
      t.assert.strictEqual(row.site_id, f.site.id);
    }
    const row = await f.create({ location: ' Zone A ', measures: ' Barrier installed ', notes: ' Inspection completed ' });
    t.assert.strictEqual(row.location, 'Zone A');
    t.assert.strictEqual(row.measures, 'Barrier installed');
    t.assert.strictEqual(row.notes, 'Inspection completed');
    for (const field of ['event_no', 'persons_involved', 'deviation_id']) t.assert.strictEqual(row[field], null);
    for (const missing of ['siteId', 'type', 'severity', 'occurredOn']) {
      await t.assert.rejects(() => f.create({ [missing]: undefined }), error(400));
    }
    for (const input of [null, [], 'event']) await t.assert.rejects(() => createHseEvent(db, input, users.owner), error(400));
  });

  await t.test('unique event numbers per site on create and update; blanks remain optional', async t => {
    const f = await fixture(), other = await fixture();
    const first = await f.create({ eventNo: ' HSE-001 ' });
    await t.assert.rejects(() => f.create({ eventNo: 'HSE-001' }), error(400));
    const second = await f.create({ eventNo: 'HSE-002' });
    await t.assert.rejects(() => updateHseEvent(db, second.id, { event_no: 'HSE-001' }, users.editor), error(400));
    await updateHseEvent(db, first.id, { eventNo: 'HSE-001' }, users.editor);
    await other.create({ event_no: 'HSE-001' });
    await f.create({ eventNo: '' });
    await f.create({ eventNo: '   ' });
    const cleared = await updateHseEvent(db, first.id, { eventNo: null }, users.editor);
    t.assert.strictEqual(cleared.event_no, null);
    await f.create({ eventNo: 'HSE-001' });
  });

  await t.test('invalid dates, enums, counts and oversized or unsupported fields are rejected', async t => {
    const f = await fixture();
    for (const occurredOn of ['', null, '2026-2-01', '2026-02-29', '2026-02-30', '2026-13-01', '2026-01-32', '0000-01-01', '2026-11-10T00:00:00Z', 123]) {
      await t.assert.rejects(() => f.create({ occurredOn }), error(400));
    }
    t.assert.strictEqual((await f.create({ occurredOn: '2024-02-29' })).occurred_on, '2024-02-29');
    for (const input of [
      { type: 'unknown' }, { severity: 'critical' }, { siteId: 'bad' },
      ...[-1, 0.5, '2', [], 2147483648].map(personsInvolved => ({ personsInvolved })),
      { eventNo: 'x'.repeat(121) }, { location: 'x'.repeat(201) },
      { measures: 'x'.repeat(2001) }, { notes: 'x'.repeat(2001) }, { measures: [] },
      { deviationId: 'bad' }, { unsupported: 'Synthetic value' },
      { occurred_on: '2026-11-09' },
    ]) await t.assert.rejects(() => f.create(input), error(400));
    for (const filters of [
      { type: 'unknown' }, { severity: 'unknown' }, { from: 'bad' }, { to: '2026-02-30' },
      { from: '2026-11-10', to: '2026-11-09' },
    ]) await t.assert.rejects(() => f.list(filters), error(400));
    const row = await f.create();
    for (const input of [{ type: null }, { severity: 'unknown' }, { occurred_on: null }, { persons_involved: -1 }, { notes: 'x'.repeat(2001) }]) {
      await t.assert.rejects(() => updateHseEvent(db, row.id, input, users.editor), error(400));
    }
    await t.assert.rejects(() => updateHseEvent(db, 'bad', {}, users.editor), error(400));
    await t.assert.rejects(() => deleteHseEvent(db, randomUUID(), users.editor), error(404, 'HSE_NOT_FOUND'));
    await t.assert.rejects(() => updateHseEvent(db, randomUUID(), {}, users.editor), error(404, 'HSE_NOT_FOUND'));
    await t.assert.rejects(() => listHseEvents(db, { siteId: randomUUID() }, users.editor), error(404, 'HSE_NOT_FOUND'));
  });

  await t.test('inclusive filters, deterministic descending order, site isolation and summary', async t => {
    const f = await fixture(), other = await fixture();
    const old = await f.create({ occurredOn: '2026-10-01' });
    const middle = await f.create({ type: 'accident', severity: 'high', occurredOn: '2026-11-01' });
    const recent = await f.create({ type: 'observation', severity: 'medium', occurredOn: '2026-11-11' });
    await other.create({ type: 'accident', severity: 'high', occurredOn: '2026-12-01' });
    t.assert.deepStrictEqual((await f.list()).map(row => row.id), [recent.id, middle.id, old.id]);
    t.assert.deepStrictEqual((await f.list({ type: 'accident', severity: 'high', from: '2026-11-01', to: '2026-11-01' })).map(row => row.id), [middle.id]);
    t.assert.deepStrictEqual(await f.list({ type: 'near_miss', severity: 'high' }), []);
    const summary = await hseSummary(db, { siteId: f.site.id }, users.verifier);
    t.assert.deepStrictEqual(summary, { by_type: { near_miss: 1, accident: 1, observation: 1 }, by_severity: { low: 1, medium: 1, high: 1 }, total: 3 });
    t.assert.strictEqual(summary.total, (await f.list()).length);
    const empty = await fixture();
    t.assert.deepStrictEqual(await hseSummary(db, { siteId: empty.site.id }, users.editor), {
      by_type: { near_miss: 0, accident: 0, observation: 0 }, by_severity: { low: 0, medium: 0, high: 0 }, total: 0,
    });
    const outsider = { id: randomUUID() };
    for (const call of [() => f.list({}, outsider), () => updateHseEvent(db, old.id, {}, outsider), () => deleteHseEvent(db, old.id, outsider)]) {
      await t.assert.rejects(call, error(403, 'HSE_FORBIDDEN'));
    }
    await t.assert.rejects(() => updateHseEvent(db, old.id, { siteId: other.site.id }, users.owner), error(400));
    const restricted = await createSite(db, { code: randomUUID(), name: 'Synthetic isolated site' });
    await db.run('INSERT INTO site_members VALUES (?, ?, ?)', restricted.id, users.owner.id, 'owner');
    const hidden = await createHseEvent(db, { siteId: restricted.id, type: 'near_miss', severity: 'low', occurredOn: '2026-11-10' }, users.owner);
    for (const call of [() => listHseEvents(db, { siteId: restricted.id }, users.editor), () => updateHseEvent(db, hidden.id, {}, users.editor), () => deleteHseEvent(db, hidden.id, users.editor)]) {
      await t.assert.rejects(call, error(403, 'HSE_FORBIDDEN'));
    }
  });

  await t.test('CRUD preserves fields and only links deviations within the site', async t => {
    const f = await fixture(), other = await fixture();
    const ownDeviation = await deviation(f.site), foreignDeviation = await deviation(other.site);
    const row = await f.create({ deviationId: ownDeviation, personsInvolved: 0, measures: 'Barrier installed' });
    t.assert.strictEqual(row.deviation_id, ownDeviation);
    const updated = await updateHseEvent(db, row.id.toUpperCase(), { occurred_on: '2026-11-11', severity: 'high', notes: ' Follow-up complete ' }, users.owner);
    t.assert.strictEqual(updated.occurred_on, '2026-11-11');
    t.assert.strictEqual(updated.severity, 'high');
    t.assert.strictEqual(updated.notes, 'Follow-up complete');
    t.assert.strictEqual(updated.persons_involved, 0);
    t.assert.strictEqual(updated.measures, row.measures);
    t.assert.strictEqual(String(updated.created_at), String(row.created_at));
    for (const deviationId of [foreignDeviation, randomUUID()]) {
      await t.assert.rejects(() => f.create({ deviationId }), error(400));
      await t.assert.rejects(() => updateHseEvent(db, row.id, { deviationId }, users.editor), error(400));
    }
    t.assert.strictEqual((await updateHseEvent(db, row.id, { deviation_id: null, persons_involved: null }, users.editor)).deviation_id, null);
    t.assert.deepStrictEqual(await deleteHseEvent(db, row.id, users.editor), { id: row.id });
    t.assert.deepStrictEqual(await f.list(), []);
  });

  await t.test('verifier reads only; viewer cannot read; role and module gates cover every operation', async t => {
    const f = await fixture(), row = await f.create();
    t.assert.strictEqual((await f.list({}, users.verifier)).length, 1);
    t.assert.strictEqual((await hseSummary(db, { siteId: f.site.id }, users.verifier)).total, 1);
    for (const role of ['viewer', 'verifier']) {
      for (const call of [() => f.create({}, users[role]), () => updateHseEvent(db, row.id, {}, users[role]), () => deleteHseEvent(db, row.id, users[role])]) {
        await t.assert.rejects(call, error(403, 'HSE_FORBIDDEN'));
      }
    }
    for (const call of [() => f.list({}, users.viewer), () => hseSummary(db, { siteId: f.site.id }, users.viewer)]) {
      await t.assert.rejects(call, error(403, 'HSE_FORBIDDEN'));
    }
    await saveModuleAccess(db, { siteId: f.site.id, memberId: users.editor.id, module: 'hse', allowed: false }, users.owner);
    for (const call of [() => f.list(), () => f.create(), () => hseSummary(db, { siteId: f.site.id }, users.editor),
      () => updateHseEvent(db, row.id, {}, users.editor), () => deleteHseEvent(db, row.id, users.editor)]) {
      await t.assert.rejects(call, error(403, 'MODULE_FORBIDDEN'));
    }
    t.assert.strictEqual((await f.list({}, users.owner)).length, 1);
    for (const call of [() => f.list({}, null), () => f.create({}, null), () => updateHseEvent(db, row.id, {}, null),
      () => deleteHseEvent(db, row.id, null), () => hseSummary(db, { siteId: f.site.id }, null)]) {
      await t.assert.rejects(call, error(401, 'UNAUTHENTICATED'));
    }
  });

  await t.test('HTTP CRUD, filters, summary, validation and access errors', async t => {
    const f = await fixture();
    const path = `/api/hse-events?site_id=${f.site.id}`;
    const body = { site_id: f.site.id, event_no: 'HTTP-001', type: 'near_miss', severity: 'low', occurred_on: '2026-11-10', persons_involved: 0 };
    const created = await api('/api/hse-events', { method: 'POST', cookie: cookies.editor, body });
    t.assert.strictEqual(created.status, 201);
    t.assert.strictEqual(created.body.persons_involved, 0);
    const id = created.body.id;
    const listed = await api(`${path}&type=near_miss&severity=low&from=2026-11-10&to=2026-11-10`, { cookie: cookies.verifier });
    t.assert.strictEqual(listed.status, 200);
    t.assert.deepStrictEqual(listed.body.map(row => row.id), [id]);
    const summary = await api(`${path}&summary=1`, { cookie: cookies.verifier });
    t.assert.strictEqual(summary.status, 200);
    t.assert.deepStrictEqual(summary.body, { by_type: { near_miss: 1, accident: 0, observation: 0 }, by_severity: { low: 1, medium: 0, high: 0 }, total: 1 });
    const patched = await api(`/api/hse-events/${id}`, { method: 'PATCH', cookie: cookies.editor, body: { severity: 'high' } });
    t.assert.strictEqual(patched.status, 200);
    t.assert.strictEqual(patched.body.severity, 'high');
    for (const role of ['viewer', 'verifier']) {
      for (const [method, url, input] of [['POST', '/api/hse-events', body], ['PATCH', `/api/hse-events/${id}`, {}], ['DELETE', `/api/hse-events/${id}`]]) {
        const result = await api(url, { method, cookie: cookies[role], body: input });
        t.assert.strictEqual(result.status, 403);
        t.assert.strictEqual(result.body.code, 'HSE_FORBIDDEN');
      }
    }
    for (const url of [path, `${path}&summary=1`]) {
      const result = await api(url, { cookie: cookies.viewer });
      t.assert.strictEqual(result.status, 403);
      t.assert.strictEqual(result.body.code, 'HSE_FORBIDDEN');
    }
    for (const url of [`${path}&from=2026-02-30`, `${path}&severity=unknown`]) {
      const result = await api(url, { cookie: cookies.editor });
      t.assert.strictEqual(result.status, 400);
      t.assert.strictEqual(result.body.code, 'HSE_INVALID');
    }
    const invalid = await api('/api/hse-events', { method: 'POST', cookie: cookies.editor, body: { ...body, occurred_on: null } });
    t.assert.strictEqual(invalid.status, 400);
    t.assert.strictEqual(invalid.body.code, 'HSE_INVALID');
    await saveModuleAccess(db, { siteId: f.site.id, memberId: users.editor.id, module: 'hse', allowed: false }, users.owner);
    for (const [method, url, input] of [['GET', path], ['GET', `${path}&summary=1`], ['POST', '/api/hse-events', body], ['PATCH', `/api/hse-events/${id}`, {}], ['DELETE', `/api/hse-events/${id}`]]) {
      const result = await api(url, { method, cookie: cookies.editor, body: input });
      t.assert.strictEqual(result.status, 403);
      t.assert.strictEqual(result.body.code, 'MODULE_FORBIDDEN');
    }
    const removed = await api(`/api/hse-events/${id}`, { method: 'DELETE', cookie: cookies.owner });
    t.assert.strictEqual(removed.status, 200);
    t.assert.deepStrictEqual(removed.body, { id });
    const missing = await api(`/api/hse-events/${id}`, { method: 'PATCH', cookie: cookies.owner, body: {} });
    t.assert.strictEqual(missing.status, 404);
    t.assert.strictEqual(missing.body.code, 'HSE_NOT_FOUND');
  });

  await t.test('migration and direct SQL replay are idempotent and preserve existing events', async t => {
    const f = await fixture(), row = await f.create({ eventNo: 'KEEP-001' });
    t.assert.strictEqual(await migrate(db, { driver }), 0);
    await applyMigration(db, '024_hse_events.sql', { driver });
    await applyMigration(db, '024_hse_events.sql', { driver });
    t.assert.deepStrictEqual((await f.list()).map(row => row.id), [row.id]);
    await t.assert.rejects(() => f.create({ eventNo: 'KEEP-001' }), error(400));
    if (driver === 'sqlite') {
      const indexes = await db.all("PRAGMA index_list('hse_events')");
      t.assert.ok(indexes.some(index => index.name === 'hse_events_site_occurred'));
      t.assert.ok(indexes.some(index => index.name === 'hse_events_site_type'));
    } else {
      const indexes = await db.all("SELECT indexname FROM pg_indexes WHERE tablename = 'hse_events'");
      t.assert.ok(indexes.some(index => index.indexname === 'hse_events_site_occurred'));
      t.assert.ok(indexes.some(index => index.indexname === 'hse_events_site_type'));
    }
  });
});

