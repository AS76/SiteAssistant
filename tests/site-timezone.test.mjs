import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { listAuditEvents } from '../server/audit.mjs';
import { createServer } from '../server/http.mjs';
import { applyMigration } from '../server/migrations/index.mjs';
import { progressCurve } from '../server/progress-curve.mjs';
import { createProgressType } from '../server/progress-types.mjs';
import { createSite } from '../server/repository.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { wbsDatabase } from './helpers/wbs.mjs';

const validationError = { status: 400, code: 'VALIDATION_ERROR' };
const at = '2026-12-20T23:30:00Z';

for (const driver of ['sqlite', 'pg']) {
  test(`040 backfills zones and cutoff on populated ${driver} sites`, async t => {
    const db = await wbsDatabase(t, driver, { beforeOperational: true });
    for (const file of ['036_wbs_operational.sql', '037_wbs_source_scope_backfill.sql', '038_identity_evidence.sql']) {
      await db.transaction(tx => applyMigration(tx, file, { driver }));
    }
    for (const jurisdiction of ['IT', 'UK']) {
      await db.run('INSERT INTO sites (id, code, name, jurisdiction, created_at) VALUES (?, ?, ?, ?, ?)',
        randomUUID(), `SYN-${jurisdiction}`, 'Synthetic upgrade site', jurisdiction, at);
    }
    const { id } = await db.get("SELECT id FROM sites WHERE jurisdiction = 'UK'");
    await db.run(`INSERT INTO diary (id, site_id, operational_date, shift, created_at)
      VALUES (?, ?, '2026-12-20', 'night', ?)`, randomUUID(), id, at);
    const diaryBefore = await db.get('SELECT * FROM diary');

    await db.transaction(tx => applyMigration(tx, '040_site_time_zone.sql', { driver }));

    const sites = await db.all('SELECT jurisdiction, time_zone, day_cutoff_time FROM sites ORDER BY jurisdiction');
    assert.deepEqual(sites.map(site => ({ ...site })), [
      { jurisdiction: 'IT', time_zone: 'Europe/Rome', day_cutoff_time: '06:00' },
      { jurisdiction: 'UK', time_zone: 'Europe/London', day_cutoff_time: '06:00' },
    ]);
    assert.deepEqual(await db.get('SELECT * FROM diary'), diaryBefore);
    for (const [column, value] of [['time_zone', null], ['time_zone', 'Europe London'], ['day_cutoff_time', '24:00']]) {
      await assert.rejects(() => db.run(`UPDATE sites SET ${column} = ? WHERE id = ?`, value, id), /constraint/i);
    }
  });

  test(`Site time zone through diary, settings and progress on ${driver}`, async t => {
    const db = await wbsDatabase(t, driver);
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at) });
    const { users, cookies } = await authFixture(db);
    const api = requestListener(createServer(db));
    const site = async input => {
      const created = await createSite(db, { code: randomUUID(), name: 'Synthetic time-zone site', ...input });
      for (const role of ['owner', 'editor']) {
        await db.run('INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, ?)', created.id, users[role].id, role);
      }
      return created;
    };
    const diary = (siteId, body = {}) => api('/api/diary', {
      method: 'POST', cookie: cookies.editor, body: { siteId, ...body },
    });

    await t.test('London 23:30 stays on 20 December and Rome keeps its operational-day rule', async () => {
      const uk = await site({ jurisdiction: 'UK', code: 'NL-UK-01' });
      const it = await site({ jurisdiction: 'IT' });
      for (const [created, zone] of [[uk, 'Europe/London'], [it, 'Europe/Rome']]) {
        const read = await api(`/api/sites/${created.id}`, { cookie: cookies.editor });
        assert.equal(read.status, 200);
        assert.equal(read.body.time_zone, zone);
        assert.equal(read.body.day_cutoff_time, '06:00');
        const response = await diary(created.id, { time_zone: zone });
        assert.equal(response.status, 201);
        assert.equal(response.body.operational_date, '2026-12-20');
        assert.equal(response.body.shift, 'night');
        assert.equal(response.body.time_zone, zone);
      }
      for (const body of [{ time_zone: 'Europe/Rome' }, { time_zone: null }, { day_cutoff_time: '03:00' }]) {
        const response = await diary(uk.id, body);
        assert.equal(response.status, validationError.status);
        assert.equal(response.body.code, validationError.code);
      }
    });

    await t.test('the same instant falls on different operational days and shifts at the local cutoff', async () => {
      t.mock.timers.setTime(Date.parse('2026-12-21T05:30:00Z'));
      const uk = await site({ jurisdiction: 'UK' });
      const it = await site({ jurisdiction: 'IT' });
      for (const [created, date, shift] of [[uk, '2026-12-20', 'night'], [it, '2026-12-21', 'day']]) {
        const entry = await diary(created.id);
        assert.equal(entry.status, 201);
        assert.equal(entry.body.operational_date, date);
        assert.equal(entry.body.shift, shift);
      }
    });

    await t.test('owner settings are validated, audited and applied to the next diary entry', async () => {
      t.mock.timers.setTime(Date.parse('2026-12-21T06:30:00Z'));
      const created = await site({ jurisdiction: 'UK' });
      const update = (body, role = 'owner') => api(`/api/sites/${created.id}`, { method: 'PATCH', cookie: cookies[role], body });
      assert.equal((await update({ day_cutoff_time: '07:45' }, 'editor')).status, 403);
      for (const body of [{ time_zone: 'Europe/Invalid' }, { time_zone: '+01:00' }, { day_cutoff_time: '06:60' }]) {
        const response = await update(body);
        assert.equal(response.status, validationError.status);
        assert.equal(response.body.code, validationError.code);
        await assert.rejects(() => site(body), validationError);
      }
      const previous = await diary(created.id);
      assert.equal(previous.body.operational_date, '2026-12-21');
      assert.equal(previous.body.shift, 'day');
      const response = await update({ time_zone: 'Europe/Rome', day_cutoff_time: '07:45' });
      assert.equal(response.status, 200);
      const events = await listAuditEvents(db, { siteId: created.id }, users.owner);
      const changes = typeof events[0].changes === 'string' ? JSON.parse(events[0].changes) : events[0].changes;
      assert.deepEqual(changes, {
        time_zone: { from: 'Europe/London', to: 'Europe/Rome' },
        day_cutoff_time: { from: '06:00', to: '07:45' },
      });
      const entry = await diary(created.id, { time_zone: 'Europe/Rome', day_cutoff_time: '07:45' });
      assert.equal(entry.status, 201);
      assert.equal(entry.body.operational_date, '2026-12-20');
      assert.equal(entry.body.shift, 'night');
      assert.equal(entry.body.day_cutoff_time, '07:45');
      const saved = await db.get('SELECT time_zone, day_cutoff_time FROM diary WHERE id = ?', previous.body.id);
      assert.deepEqual({ ...saved }, { time_zone: 'Europe/London', day_cutoff_time: '06:00' });
    });

    await t.test('progress has identical points for matching local dates across the spring transition', async () => {
      const curves = [];
      for (const [jurisdiction, before, after] of [['IT', '+01:00', '+02:00'], ['UK', '+00:00', '+01:00']]) {
        const created = await site({ jurisdiction });
        const type = await createProgressType(db, {
          site_id: created.id, code: 'SYN', name: 'Synthetic progress', steps: [{ position: 1, code: 'STEP', weight: 100 }],
        }, users.owner);
        const item = randomUUID();
        await db.run(`INSERT INTO site_progress_items
          (id, site_id, section, source_row, created_at, progress_type_id, planned_start, planned_finish)
          VALUES (?, ?, 'Synthetic section', 1, ?, ?, ?, ?)`,
        item, created.id, at, type.id, `2026-03-28T00:15:00${before}`, `2026-03-30T00:15:00${after}`);
        for (const [timestamp, value] of [[`2026-03-28T23:30:00${before}`, 25], [`2026-03-30T00:00:00${after}`, 70]]) {
          await db.run(`INSERT INTO progress_entries
            (id, site_id, site_progress_item_id, progress_type_step_id, percent, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?)`, randomUUID(), created.id, item, type.steps[0].id, value, timestamp);
        }
        curves.push(await progressCurve(db, { siteId: created.id, user: users.editor, from: '2026-03-27', to: '2026-03-30' }));
      }
      assert.deepEqual(curves[0], curves[1]);
      assert.deepEqual(curves[0].series[0].points, [
        { date: '2026-03-27', planned: 0 },
        { date: '2026-03-28', planned: 0, actual: 25 },
        { date: '2026-03-29', planned: 50, actual: 25 },
        { date: '2026-03-30', planned: 100, actual: 70 },
      ]);
    });
  });
}
