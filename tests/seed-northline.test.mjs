import { provisionDemoFixture, withDemoEnvironment } from './helpers/demo-seed.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createLoginLimiter, login } from '../server/auth.mjs';
import { certificationStatus } from '../server/certifications.mjs';
import { operationalDate } from '../server/operational-day.mjs';
import { apply as applyDemo } from '../server/seed-demo.mjs';
import { apply, plan, reset } from '../server/seed-northline.mjs';
import { wbsDatabase } from './helpers/wbs.mjs';

const EXPECTED = {
  sites: 2, users: 7, site_members: 10, project_structure: 48, tasks: 36, task_events: 88, diary: 48,
  progress_types: 6, progress_type_steps: 10, site_progress_items: 24, site_progress_item_steps: 40, progress_entries: 72,
  employees: 28, work_days: 560, time_bookings: 120, employee_certifications: 32,
  deviations: 16, deviation_links: 4, cost_impacts: 2, cost_impact_deviations: 2,
  tools: 16, hse_events: 20, hse_assets: 4, hse_inspections: 8, hse_inspection_items: 64,
  purchase_orders: 6, purchase_order_items: 8, packages: 8, package_items: 8,
  shipments: 4, shipment_packages: 4, shipment_receipts: 4,
};

async function snapshot(db) {
  const tables = [...Object.keys(EXPECTED), 'sessions', 'audit_events', 'demo_seed_records'];
  const result = {};
  for (const table of tables) {
    result[table] = (await db.all(`SELECT * FROM ${table}`)).map(row => JSON.stringify(row)).sort();
  }
  return result;
}

test('Northline dry-run plan reports both sites and all seeded table counts', () => {
  assert.deepEqual(plan().counts, EXPECTED);
  assert.deepEqual(plan().sites.map(site => site.code), ['NL-IT-01', 'NL-UK-01']);
});

test('Northline rows are coherent and reapply/reset preserve the five existing demo sites', async t => {
  const db = await wbsDatabase(t, 'sqlite');
  await provisionDemoFixture(db);
  await withDemoEnvironment(() => applyDemo(db));
  const baseline = await snapshot(db);
  assert.deepEqual((await db.all('SELECT code FROM sites ORDER BY code')).map(row => row.code),
    ['FITT-01', 'FITT-02', 'FITT-03', 'FITT-04', 'FITT-05']);
  const classicTasks = await db.all(`SELECT t.status, t.declared_at, t.verified_at, t.created_at, submitted.at AS submitted_at, checked.at AS checked_at
    FROM tasks t
    JOIN task_events submitted ON submitted.task_id = t.id AND submitted.action = 'submit'
    LEFT JOIN task_events checked ON checked.task_id = t.id AND checked.action = 'verify'`);
  assert.ok(classicTasks.some(task => task.status === 'to_verify'));
  assert.ok(classicTasks.some(task => task.checked_at));
  for (const task of classicTasks) {
    assert.equal(task.declared_at, task.submitted_at);
    assert.equal(task.verified_at, task.checked_at);
    assert.ok(task.declared_at >= task.created_at);
    if (task.verified_at) assert.ok(task.verified_at > task.declared_at);
  }

  const password = randomBytes(24).toString('base64url');
  assert.deepEqual(await apply(db, { password }), EXPECTED);
  const installed = await snapshot(db);
  for (const [table, count] of Object.entries(EXPECTED)) {
    assert.equal(installed[table].length - baseline[table].length, count, table);
  }

  const sites = await db.all("SELECT * FROM sites WHERE code IN ('NL-IT-01', 'NL-UK-01') ORDER BY code");
  assert.deepEqual(sites.map(site => [site.code, site.jurisdiction, site.start_date, site.end_date]), [
    ['NL-IT-01', 'IT', '2026-09-07', '2027-02-27'], ['NL-UK-01', 'UK', '2026-09-14', '2027-03-06'],
  ]);
  for (const [index, site] of sites.entries()) {
    const siteRows = table => db.all(`SELECT * FROM ${table} WHERE site_id = ?`, site.id);
    const country = site.jurisdiction.toLowerCase();
    const other = index ? 'it' : 'uk';
    const members = await db.all(`SELECT u.email, m.role FROM site_members m JOIN users u ON u.id = m.user_id
      WHERE m.site_id = ?`, site.id);
    assert.deepEqual(Object.fromEntries(members.map(row => [row.email, row.role])), {
      [`owner.${country}@northline.invalid`]: 'owner', [`owner.${other}@northline.invalid`]: 'viewer',
      [`editor.${country}@northline.invalid`]: 'editor', [`verifier.${country}@northline.invalid`]: 'verifier',
      'viewer@northline.invalid': 'viewer',
    });

    const wbs = await siteRows('project_structure');
    assert.equal(wbs.filter(node => node.parent_id === null).length, 10);
    assert.equal(wbs.filter(node => node.parent_id !== null).length, 14);
    assert.ok(wbs.every(node => node.planned_hours > 0 && node.planned_start < node.planned_finish && node.section && node.plc_area));
    const tasks = await siteRows('tasks');
    assert.deepEqual(new Set(tasks.map(row => row.status)), new Set(['todo', 'in_progress', 'to_verify', 'closed', 'blocked']));
    assert.equal(tasks.filter(row => row.kind === 'corrective').length, 2);
    for (const task of tasks) {
      assert.ok(task.executor_id && task.verifier_id && task.executor_id !== task.verifier_id);
      const events = await db.all('SELECT * FROM task_events WHERE task_id = ? ORDER BY at', task.id);
      assert.match(events[0].note, index ? /^Acceptance criterion:/ : /^Criterio di accettazione:/);
      assert.equal(events.at(-1).to_status, task.status);
      assert.ok(events.every((event, i) => i === 0 || event.from_status === events[i - 1].to_status));
      assert.equal(task.declared_at, events.find(event => event.action === 'submit')?.at ?? null);
      assert.equal(task.verified_at, events.find(event => event.action === 'verify')?.at ?? null);
      if (task.declared_at) assert.ok(task.declared_at > task.created_at);
      if (task.verified_at) assert.ok(task.verified_at > task.declared_at);
    }

    const diary = await siteRows('diary');
    assert.equal(diary.filter(row => row.shift === 'day').length, 20);
    const nights = diary.filter(row => row.shift === 'night');
    assert.equal(nights.length, 4);
    for (const night of nights) {
      assert.equal(night.time_zone, index ? 'Europe/London' : 'Europe/Rome');
      assert.equal(night.day_cutoff_time, '06:00');
      assert.equal(operationalDate(new Date(night.created_at), { timeZone: night.time_zone, cutoff: night.day_cutoff_time }), night.operational_date);
    }
    const employees = await siteRows('employees');
    assert.equal(employees.length, 14);
    const attendance = await siteRows('work_days');
    for (const employee of employees) {
      const rows = attendance.filter(row => row.employee_id === employee.id);
      assert.equal(new Set(rows.map(row => row.operational_date)).size, 20);
    }
    assert.equal(attendance.filter(row => row.shift === 'night' && row.finish_time < row.start_time).length, 12);
    assert.ok(attendance.some(row => row.work_time === 9));
    const bookings = await db.all(`SELECT b.hours, w.booked_hours, w.work_time FROM time_bookings b
      JOIN work_days w ON w.id = b.work_day_id WHERE b.site_id = ?`, site.id);
    assert.equal(bookings.length, 60);
    assert.ok(bookings.every(row => row.hours <= row.work_time));
    assert.ok(bookings.some(row => row.hours !== row.booked_hours));

    assert.equal((await siteRows('progress_types')).length, 3);
    assert.equal((await siteRows('site_progress_items')).length, 12);
    assert.equal((await siteRows('progress_entries')).length, 36);
    const binary = await db.all(`SELECT e.percent FROM progress_entries e JOIN progress_type_steps s ON s.id = e.progress_type_step_id
      JOIN progress_types t ON t.id = s.progress_type_id WHERE e.site_id = ? AND t.code = 'binary_pct'`, site.id);
    assert.deepEqual(binary.map(row => row.percent).sort(), [0, 0, 100, 100]);

    const corrections = await db.all(`SELECT t.kind FROM deviation_links l JOIN tasks t ON t.id = l.entity_id
      JOIN deviations d ON d.id = l.deviation_id WHERE d.site_id = ? AND t.site_id = d.site_id AND l.entity_type = 'task'`, site.id);
    assert.deepEqual(corrections.map(row => row.kind), ['corrective', 'corrective']);
    const events = await siteRows('hse_events');
    assert.deepEqual(events.map(row => row.type).sort(), [
      'accident', 'accident', 'near_miss', 'near_miss', 'near_miss', 'near_miss', 'observation', 'observation', 'observation', 'observation',
    ]);
    assert.ok((await siteRows('hse_assets')).every(row => row.template_code.startsWith(`${country}_`)));
    for (const inspection of await siteRows('hse_inspections')) {
      const checks = await db.all('SELECT * FROM hse_inspection_items WHERE inspection_id = ?', inspection.id);
      assert.equal(checks.length, 8);
      if (inspection.outcome === 'fail') assert.ok(checks.some(row => row.result === 'not_ok' && row.note.includes('DEV-05')));
    }
    const certs = (await siteRows('employee_certifications')).map(row => certificationStatus(row.expires_on, plan().referenceDay).status);
    assert.equal(certs.filter(status => status === 'expired').length, 3);
    assert.equal(certs.filter(status => status === 'expiring').length, 3);
    const receipts = await db.all(`SELECT s.status, r.quantity_received, p.quantity_packed, r.note FROM shipment_receipts r
      JOIN shipments s ON s.id = r.shipment_id
      JOIN shipment_packages sp ON sp.shipment_id = s.id
      JOIN package_items p ON p.package_id = sp.package_id AND p.purchase_order_item_id = r.purchase_order_item_id
      WHERE s.site_id = ? ORDER BY s.status`, site.id);
    assert.deepEqual(receipts.map(row => [row.status, row.quantity_received, row.quantity_packed]),
      [['arrived', 6, 8], ['received', 12, 12]]);
    assert.match(receipts[0].note, index ? /dented/ : /ammaccato/);
  }

  await login(db, { email: 'owner.it@northline.invalid', password }, { limiter: createLoginLimiter() });
  await db.run('UPDATE sites SET location = ? WHERE id = ?', 'Zona simulata aggiornata', sites[0].id);
  const edited = await snapshot(db);
  assert.ok(Object.values(await apply(db, { password: randomBytes(24).toString('base64url') })).every(count => count === 0));
  assert.deepEqual(await snapshot(db), edited);

  await db.run(`INSERT INTO diary (id, site_id, operational_date, shift, created_at)
    VALUES ('pilot-extra-diary', ?, '2026-11-18', 'day', '2026-11-18T16:00:00.000Z')`, sites[0].id);
  const withExtra = await snapshot(db);
  await assert.rejects(reset(db), /foreign key/i);
  assert.deepEqual(await snapshot(db), withExtra);
  await db.run("DELETE FROM diary WHERE id = 'pilot-extra-diary'");
  assert.deepEqual(await reset(db), { ...EXPECTED, sessions: 1 });
  assert.deepEqual(await snapshot(db), baseline);
  assert.ok(Object.values(await reset(db)).every(count => count === 0));

  assert.deepEqual(await apply(db, { password }), EXPECTED);
  const restored = await db.all("SELECT id FROM sites WHERE code IN ('NL-IT-01', 'NL-UK-01') ORDER BY code");
  assert.deepEqual(restored.map(row => row.id), sites.map(site => site.id));
});

test('Northline inserts and resets through the PostgreSQL schema', async t => {
  const db = await wbsDatabase(t, 'pg');
  assert.deepEqual(await apply(db), EXPECTED);
  assert.ok(Object.values(await apply(db)).every(count => count === 0));
  assert.deepEqual(await reset(db), { ...EXPECTED, sessions: 0 });
  assert.equal(Number((await db.get('SELECT COUNT(*) AS count FROM sites')).count), 0);
});
