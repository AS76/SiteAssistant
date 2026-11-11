import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createSite } from '../server/repository.mjs';
import { createServer } from '../server/http.mjs';
import { listCertifications, createCertification, updateCertification, deleteCertification,
  certificationStatus, certificationSummary, CERT_CATEGORIES } from '../server/certifications.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { migrate } from '../server/migrations/index.mjs';
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

const offsetDate = days => {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

for (const driver of ['sqlite', 'pg']) test(`Employee certifications ${driver}`, async t => {
  const db = await database(t, driver);
  const { users, cookies } = await authFixture(db);
  const api = requestListener(createServer(db));
  const error = (status, code) => ({ status, code });

  const fixture = async () => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic certifications site' });
    for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
      await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, users[role].id, role);
    }
    const employeeId = randomUUID();
    await db.run(`INSERT INTO employees (id, site_id, employee_no, first_name, last_name, created_at)
      VALUES (?, ?, 'SYN-1', 'Synthetic', 'Worker', ?)`, employeeId, site.id, new Date().toISOString());
    return {
      site, employeeId,
      create: (input = {}, user = users.editor) => createCertification(db, {
        siteId: site.id, employeeId, name: 'Synthetic certificate', category: 'qualification', ...input,
      }, user),
      list: (filters = {}, user = users.editor) => listCertifications(db, { siteId: site.id, ...filters }, user),
    };
  };

  await t.test('status is derived from the expiry date, never stored', async () => {
    const today = '2026-11-11';
    t.assert.deepStrictEqual(certificationStatus(null, today), { status: 'no_expiry', days_left: null });
    t.assert.deepStrictEqual(certificationStatus('2026-11-10', today), { status: 'expired', days_left: -1 });
    t.assert.deepStrictEqual(certificationStatus('2026-11-11', today), { status: 'expiring', days_left: 0 });
    t.assert.deepStrictEqual(certificationStatus('2026-12-11', today), { status: 'expiring', days_left: 30 });
    t.assert.deepStrictEqual(certificationStatus('2026-12-12', today), { status: 'valid', days_left: 31 });
    t.assert.deepStrictEqual(certificationStatus('2026-12-11', today, 10), { status: 'valid', days_left: 30 });
  });

  await t.test('create, read, filter and isolation between sites', async t => {
    const f = await fixture(), other = await fixture();
    const expired = await f.create({ name: 'Expired check', category: 'medical', expiresOn: offsetDate(-5), outcome: ' Idoneo ' });
    const expiring = await f.create({ name: 'Lapsing licence', category: 'qualification', expiresOn: offsetDate(10) });
    const valid = await f.create({ name: 'Fresh training', category: 'training', expiresOn: offsetDate(900) });
    const permanent = await f.create({ name: 'No expiry course', category: 'other' });
    await other.create({ name: 'Other site certificate' });

    t.assert.strictEqual(expired.status, 'expired');
    t.assert.strictEqual(expired.outcome, 'Idoneo');
    t.assert.strictEqual(expiring.status, 'expiring');
    t.assert.strictEqual(valid.status, 'valid');
    t.assert.strictEqual(permanent.status, 'no_expiry');
    t.assert.strictEqual(permanent.expires_on, null);

    t.assert.deepStrictEqual((await f.list()).map(row => row.id), [expired.id, expiring.id, valid.id, permanent.id]);
    t.assert.deepStrictEqual((await f.list({ status: 'expiring' })).map(row => row.id), [expiring.id]);
    t.assert.deepStrictEqual((await f.list({ category: 'medical' })).map(row => row.id), [expired.id]);
    t.assert.deepStrictEqual((await f.list({ employeeId: f.employeeId })).length, 4);
    t.assert.deepStrictEqual((await f.list({ within: 0 })).map(row => row.status), ['expired', 'valid', 'valid', 'no_expiry']);
    t.assert.deepStrictEqual(await certificationSummary(db, { siteId: f.site.id }, users.editor),
      { counts: { expired: 1, expiring: 1, valid: 1, no_expiry: 1 }, total: 4 });
    t.assert.ok(!(await f.list()).some(row => row.name === 'Other site certificate'));
  });

  await t.test('validation, role checks and unauthenticated access', async t => {
    const f = await fixture();
    const cert = await f.create({ name: 'Initial', category: 'medical', expiresOn: offsetDate(100) });
    for (const invalid of [
      () => f.create({ category: 'unknown' }),
      () => f.create({ name: '   ' }),
      () => f.create({ name: 'x'.repeat(121) }),
      () => f.create({ category: 'other', name: 'Bad date', expiresOn: '2026-02-30' }),
      () => f.create({ category: 'other', name: 'Bad order', issuedOn: offsetDate(10), expiresOn: offsetDate(5) }),
      () => f.create({ name: 'Wrong employee', employeeId: randomUUID() }),
      () => f.create({ siteId: 'not-a-uuid' }),
      () => updateCertification(db, cert.id, { category: 'unknown' }, users.editor),
      () => f.list({ status: 'unknown' }),
      () => f.list({ category: 'unknown' }),
      () => f.list({ within: 400 }),
      () => f.list({ within: 1.5 }),
      () => updateCertification(db, 'not-a-uuid', {}, users.editor),
    ]) await t.assert.rejects(invalid, error(400, 'CERT_INVALID'));
    await t.assert.rejects(updateCertification(db, randomUUID(), {}, users.editor), error(404, 'CERT_NOT_FOUND'));
    await t.assert.rejects(deleteCertification(db, randomUUID(), users.editor), error(404, 'CERT_NOT_FOUND'));

    for (const call of [
      () => f.create({}, users.viewer),
      () => updateCertification(db, cert.id, { name: 'Denied' }, users.viewer),
      () => deleteCertification(db, cert.id, users.viewer),
      () => f.list({}, users.viewer),
    ]) await t.assert.rejects(call, error(403, 'CERT_FORBIDDEN'));
    // A verifier reads (site fitness checks) but does not write.
    t.assert.strictEqual((await f.list({}, users.verifier)).length, 1);
    await t.assert.rejects(() => f.create({}, users.verifier), error(403, 'CERT_FORBIDDEN'));

    for (const call of [
      () => f.list({}, null),
      () => createCertification(db, { siteId: f.site.id, employeeId: f.employeeId, name: 'No session' }, null),
      () => updateCertification(db, cert.id, {}, null),
      () => deleteCertification(db, cert.id, null),
    ]) await t.assert.rejects(call, error(401, 'UNAUTHENTICATED'));

    const changed = await updateCertification(db, cert.id.toUpperCase(), { expiresOn: offsetDate(200), notes: ' Updated ' }, users.editor);
    t.assert.strictEqual(changed.expires_on, offsetDate(200));
    t.assert.strictEqual(changed.notes, 'Updated');
    t.assert.strictEqual(changed.name, 'Initial');
    t.assert.strictEqual(await updateCertification(db, cert.id, { expiresOn: null }, users.editor).then(row => row.status), 'no_expiry');

    await deleteCertification(db, cert.id, users.owner);
    t.assert.deepStrictEqual(await f.list(), []);
  });

  await t.test('HTTP routes, filters, summary and error codes', async t => {
    const f = await fixture();
    const created = await api('/api/certifications', { method: 'POST', cookie: cookies.editor,
      body: { site_id: f.site.id, employee_id: f.employeeId, name: 'HTTP medical', category: 'medical', expires_on: offsetDate(7) } });
    t.assert.strictEqual(created.status, 201);
    t.assert.strictEqual(created.body.status, 'expiring');
    t.assert.strictEqual(created.body.site_id, f.site.id);

    const listed = await api(`/api/certifications?site_id=${f.site.id}&status=expiring`, { cookie: cookies.verifier });
    t.assert.strictEqual(listed.status, 200);
    t.assert.deepStrictEqual(listed.body.map(row => row.id), [created.body.id]);
    const camel = await api(`/api/certifications?siteId=${f.site.id}&status=expiring`, { cookie: cookies.editor });
    t.assert.strictEqual(camel.status, 200);
    const summary = await api(`/api/certifications?site_id=${f.site.id}&summary=1`, { cookie: cookies.editor });
    t.assert.deepStrictEqual(summary.body, { counts: { expired: 0, expiring: 1, valid: 0, no_expiry: 0 }, total: 1 });

    const patched = await api(`/api/certifications/${created.body.id}`, { method: 'PATCH', cookie: cookies.editor,
      body: { name: 'HTTP medical updated', expires_on: offsetDate(-1) } });
    t.assert.strictEqual(patched.status, 200);
    t.assert.strictEqual(patched.body.status, 'expired');
    const removed = await api(`/api/certifications/${created.body.id}`, { method: 'DELETE', cookie: cookies.editor });
    t.assert.strictEqual(removed.status, 200);
    t.assert.deepStrictEqual(await api(`/api/certifications?site_id=${f.site.id}`, { cookie: cookies.editor }).then(r => r.body), []);

    for (const [request, status, code] of [
      [() => api('/api/certifications', { method: 'POST', cookie: cookies.viewer, body: { site_id: f.site.id, employee_id: f.employeeId, name: 'Denied' } }), 403, 'CERT_FORBIDDEN'],
      [() => api(`/api/certifications?site_id=${f.site.id}`, { cookie: cookies.viewer }), 403, 'CERT_FORBIDDEN'],
      [() => api('/api/certifications', { method: 'POST', cookie: cookies.editor, body: { site_id: f.site.id, employee_id: f.employeeId, name: 'Bad', category: 'unknown' } }), 400, 'CERT_INVALID'],
      [() => api(`/api/certifications?site_id=${f.site.id}&status=unknown`, { cookie: cookies.editor }), 400, 'CERT_INVALID'],
      [() => api(`/api/certifications?site_id=${randomUUID()}`, { cookie: cookies.editor }), 404, 'SITE_NOT_FOUND'],
    ]) {
      const response = await request();
      t.assert.strictEqual(response.status, status);
      t.assert.strictEqual(response.body.code, code);
    }
  });

  await t.test('migration is idempotent and every category is accepted', async t => {
    const f = await fixture();
    for (const category of CERT_CATEGORIES) await f.create({ name: `Category ${category}`, category });
    t.assert.deepStrictEqual((await f.list()).map(row => row.category).sort(), [...CERT_CATEGORIES].sort());
    t.assert.strictEqual(await migrate(db, { driver }), 0);
  });
});
