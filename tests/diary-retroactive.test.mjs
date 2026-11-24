import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../app/api.mjs';
import { createLoginLimiter, login } from '../server/auth.mjs';
import { createServer } from '../server/http.mjs';
import { saveModuleAccess } from '../server/module-access.mjs';
import { createSite } from '../server/repository.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { wbsDatabase } from './helpers/wbs.mjs';

for (const driver of ['sqlite', 'pg']) {
  test(`Diary corrections and retroactive entries on ${driver === 'pg' ? 'PGlite' : 'SQLite'}`, async t => {
    const db = await wbsDatabase(t, driver);
    // Rome is already on 30 March, while UTC is still on 29 March.
    const now = '2026-03-29T22:30:00.000Z';
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
    const site = await createSite(db, { code: 'DIARY-TEST', name: 'Synthetic diary site', time_zone: 'Europe/Rome', day_cutoff_time: '06:15' });
    const { users, cookies } = await authFixture(db, site);
    const request = requestListener(createServer(db));
    const post = (day, role = 'editor', body = {}) => request('/api/diary', {
      method: 'POST', cookie: cookies[role],
      body: { siteId: site.id, operational_date: day, shift: 'day', plan: 'Original plan', ...body },
    });
    const entryPath = id => `/api/diary/${id}`;
    const patch = (id, body, role = 'editor') => request(entryPath(id), { method: 'PATCH', cookie: cookies[role], body });
    const versions = (id, role = 'viewer') => request(`${entryPath(id)}/versions`, { cookie: cookies[role] });
    const expectError = (response, status, code) => {
      assert.equal(response.status, status, JSON.stringify(response.body));
      assert.equal(response.body.code, code);
    };
    const reason = 'Reviewed the original shift log';

    expectError(await post('2026-03-31', 'owner'), 400, 'VALIDATION_ERROR');
    expectError(await post('2026-02-28'), 403, 'FORBIDDEN');
    expectError(await post('2026-02-28', 'owner', { motivation: '   ' }), 400, 'MOTIVATION_REQUIRED');
    const late = await post('2026-02-28', 'owner', { motivation: reason });
    assert.equal(late.status, 201, JSON.stringify(late.body));
    assert.equal(late.body.recorded_late, true);
    assert.equal(late.body.recording_motivation, reason);
    assert.equal(late.body.author_id, users.owner.id);

    const yesterday = await post('2026-03-29');
    assert.equal(yesterday.status, 201);
    assert.equal(yesterday.body.recorded_late, false);
    const boundary = await post('2026-03-23');
    assert.equal(boundary.status, 201);
    assert.equal(boundary.body.recorded_late, false);
    expectError(await patch(boundary.body.id, { plan: 'Too late', motivation: reason }), 403, 'FORBIDDEN');

    t.mock.timers.setTime(Date.parse('2026-03-28T22:59:59.999Z'));
    const entry = await post('2026-03-28', 'verifier');
    assert.equal(entry.status, 201, JSON.stringify(entry.body));
    const { id } = entry.body;
    expectError(await patch(id, { operational_date: '2026-03-27', actual: 'Changed', motivation: reason }), 400, 'VALIDATION_ERROR');
    expectError(await patch(id, { plan: 'Changed', motivation: reason }, 'verifier'), 403, 'FORBIDDEN');
    expectError(await patch(id, { plan: 'Changed', motivation: reason }, 'viewer'), 403, 'FORBIDDEN');
    expectError(await patch(id, { plan: 'Changed' }, 'owner'), 400, 'MOTIVATION_REQUIRED');
    expectError(await patch(id, { plan: 'Changed' }), 400, 'MOTIVATION_REQUIRED');
    assert.deepEqual((await versions(id)).body, []);

    // The night shift keeps the same operational date across local midnight
    // and the spring clock jump. Use a non-default cutoff to detect hardcoding.
    for (const instant of ['2026-03-28T23:00:00.000Z', '2026-03-29T00:59:59.999Z', '2026-03-29T01:00:00.000Z']) {
      t.mock.timers.setTime(Date.parse(instant));
      expectError(await patch(id, { plan: 'Changed' }), 400, 'MOTIVATION_REQUIRED');
    }
    const beforeCutoff = '2026-03-29T04:14:59.999Z';
    t.mock.timers.setTime(Date.parse(beforeCutoff));
    const correction = await patch(id, { plan: '', actual: 'Revised result', motivation: `  ${reason}  ` });
    assert.equal(correction.status, 200, JSON.stringify(correction.body));
    assert.equal(correction.body.plan, '');
    assert.equal(correction.body.updated_by, users.editor.id);
    assert.equal(correction.body.updated_by_name, users.editor.name);
    assert.equal(correction.body.updated_at, beforeCutoff);
    assert.equal(correction.body.operational_date, '2026-03-28');
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM diary_entry_versions WHERE diary_id = ?', id)).count.toString(), '1');

    t.mock.timers.setTime(Date.parse('2026-03-29T04:15:00.000Z'));
    expectError(await patch(id, { plan: 'Too late', motivation: reason }), 403, 'FORBIDDEN');
    expectError(await patch(id, { plan: 'Changed', motivation: ' 123456789 ' }, 'owner'), 400, 'MOTIVATION_REQUIRED');
    const ownerEdit = await patch(id, { next_step: 'Verify tomorrow', motivation: reason }, 'owner');
    assert.equal(ownerEdit.status, 200);
    assert.equal(ownerEdit.body.recorded_late, false);
    assert.equal(ownerEdit.body.updated_by, users.owner.id);
    assert.equal(ownerEdit.body.actual, 'Revised result');

    expectError(await patch(late.body.id, { plan: 'Changed' }, 'owner'), 400, 'MOTIVATION_REQUIRED');
    assert.equal((await patch(late.body.id, { plan: 'Changed', motivation: reason }, 'owner')).status, 200);
    const history = await versions(id);
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.map(row => [row.version, row.author_id, row.author_name, row.motivation, row.snapshot.plan]), [
      [2, users.owner.id, users.owner.name, reason, ''],
      [1, users.editor.id, users.editor.name, reason, 'Original plan'],
    ]);
    assert.equal(history.body[1].snapshot.updated_at, null);
    assert.equal(history.body[1].snapshot.author_id, users.verifier.id);
    assert.equal(history.body[1].created_at, beforeCutoff);
    assert.equal(history.body[0].snapshot.updated_at, history.body[1].created_at);
    assert.equal(history.body[0].created_at, ownerEdit.body.updated_at);

    const parallel = await Promise.all([
      patch(id, { plan: 'Follow-up plan', motivation: reason }, 'owner'),
      patch(id, { impediments: 'New impediment', motivation: reason }, 'owner'),
    ]);
    assert.deepEqual(parallel.map(row => row.status), [200, 200]);
    assert.deepEqual((await versions(id)).body.map(row => row.version), [4, 3, 2, 1]);
    const { body: entries } = await request(`/api/diary?siteId=${site.id}`, { cookie: cookies.viewer });
    const current = entries.find(row => row.id === id);
    assert.equal(current.plan, 'Follow-up plan');
    assert.equal(current.impediments, 'New impediment');

    expectError(await request(entryPath(id), { method: 'DELETE', cookie: cookies.owner }), 404, 'NOT_FOUND');
    await assert.rejects(() => db.run('DELETE FROM diary WHERE id = ?', id), /foreign key/i);
    await saveModuleAccess(db, { siteId: site.id, memberId: users.viewer.id, module: 'diary', allowed: false }, users.owner);
    expectError(await versions(id), 403, 'MODULE_FORBIDDEN');
    await db.run('DELETE FROM site_members WHERE site_id = ? AND user_id = ?', site.id, users.verifier.id);
    expectError(await versions(id, 'verifier'), 403, 'FORBIDDEN');

    t.mock.timers.setTime(Date.parse('2026-10-24T21:00:00.000Z'));
    const session = await login(db, { email: users.editor.email, password: 'Synthetic-test-password!' }, { limiter: createLoginLimiter() });
    cookies.editor = `sa_session=${session.token}`;
    const autumn = await post('2026-10-24');
    assert.equal(autumn.status, 201, JSON.stringify(autumn.body));
    for (const instant of ['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z', '2026-10-25T05:14:59.999Z']) {
      t.mock.timers.setTime(Date.parse(instant));
      assert.equal((await patch(autumn.body.id, { actual: instant, motivation: reason })).status, 200);
    }
    t.mock.timers.setTime(Date.parse('2026-10-25T05:15:00.000Z'));
    expectError(await patch(autumn.body.id, { actual: 'Too late', motivation: reason }), 403, 'FORBIDDEN');
  });
}

test('diary client sends partial corrections and fetches history', async () => {
  const api = createApi({ baseUrl: '/', fetchImpl: async (url, options) => {
    if (url === '/api/diary/entry/versions') {
      assert.equal(options.method, undefined);
      return Response.json([{ version: 1, snapshot: { impediments: 'Old obstruction' } }]);
    }
    assert.equal(url, '/api/diary/entry');
    assert.equal(options.method, 'PATCH');
    assert.deepEqual(JSON.parse(options.body), { impediments: '', motivation: 'Corrected shift log' });
    return Response.json({ id: 'entry', impediments: '', operational_date: '2026-03-29' });
  } });
  assert.equal((await api.updateDiary('entry', { impediments: '', motivation: 'Corrected shift log' })).blockers, '');
  assert.equal((await api.listDiaryVersions('entry'))[0].snapshot.impediments, 'Old obstruction');
});
