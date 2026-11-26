import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { assignDemoUser, changePermission, INVITATION_PERMISSION, markDemoSite } from '../server/admin.mjs';
import { memberships } from '../server/auth.mjs';
import { createUser, parseArgs } from '../server/create-user.mjs';
import { migrateDemoSandbox } from '../server/demo-sandbox.mjs';
import { createServer } from '../server/http.mjs';
import { applyMigration, migrate } from '../server/migrations/index.mjs';
import { MODULES } from '../server/module-access.mjs';
import { createSite, createTask } from '../server/repository.mjs';
import { apply as applyDemo, reset as resetDemo } from '../server/seed-demo.mjs';
import { scopeFor } from '../app/offline.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { database } from './helpers/procurement.mjs';
import { MemoryObjectStorage, taskEvidenceInput } from './helpers/object-storage.mjs';
import { assertUpgrade } from './helpers/migrations.mjs';

const password = 'Synthetic-demo-passphrase!';
const stamp = '2026-01-01T12:00:00.000Z';
const invitationPath = '/api/admin/invitations';
const taskInput = siteId => ({ siteId, title: 'Synthetic test task', executor: 'Crew A', verifier: 'Crew B' });

async function fixture(t, driver = 'sqlite') {
  const db = await database(t, driver);
  const site = await createSite(db, { code: 'TEST-SANDBOX', name: 'Synthetic sandbox' }, { demoSandbox: true });
  const outside = await createSite(db, { code: 'TEST-OTHER', name: 'Synthetic restricted site' });
  const { users, cookies } = await authFixture(db, site);
  const demo = await createUser(db, { email: 'tester@example.invalid', name: 'Synthetic tester', password, siteCode: site.code, role: 'demo_user' });
  const storage = new MemoryObjectStorage(), mail = [];
  const request = requestListener(createServer(db, {
    demoSandbox: true, storage, publicUrl: 'https://demo.example.invalid',
    mailer: async message => { mail.push(message); },
    reporting: async ({ scopeIds }) => ({ scopeIds }),
    reportingGlobalOwnerIds: demo.id,
  }));
  const login = async (email, chosen = password) => {
    const response = await request('/api/auth/login', { method: 'POST', body: { email, password: chosen } });
    t.assert.strictEqual(response.status, 200);
    return response.headers['set-cookie'].split(';')[0];
  };
  cookies.demo = await login(demo.email);
  const call = async (path, status, { role = 'demo', method = 'GET', body } = {}) => {
    const response = await request(path, { cookie: cookies[role], method, body });
    t.assert.strictEqual(response.status, status, `${role} ${method} ${path}: ${JSON.stringify(response.body)}`);
    return response.body;
  };
  const write = (path, status, body, role, method = 'POST') => call(path, status, { role, method, body });
  return { db, site, outside, demo, users, cookies, call, write, request, mail, storage };
}

test('site creation grants demo membership atomically; a viewer cannot create a site', async t => {
  const f = await fixture(t);
  const input = { code: 'TEST-CREATED', name: 'Synthetic created site', demo_sandbox: false, role: 'owner' };
  await f.write('/api/sites', 403, input, 'viewer');
  const site = await f.write('/api/sites', 201, input);
  t.assert.ok((await f.db.get('SELECT demo_sandbox FROM sites WHERE id = ?', site.id)).demo_sandbox);
  t.assert.deepStrictEqual((await f.call('/api/auth/me', 200)).roles.find(row => row.site_id === site.id),
    { site_id: site.id, role: 'demo_user' });
  await f.call(`/api/sites/${site.id}`, 200);
  await f.call(`/api/sites/${site.id}`, 404, { method: 'DELETE' });
  await f.call(`/api/sites/${site.id}`, 200);
  t.assert.strictEqual((await f.write('/api/sites', 409, input)).code, 'DUPLICATE_SITE_CODE');
});

test('task creation, WBS edits and assigned review work in the sandbox; viewer and unassigned review are rejected', async t => {
  const f = await fixture(t), siteId = f.site.id;
  const node = await f.write('/api/wbs', 201, { site_id: siteId, wbs_code: 'DEMO-WBS' });
  await f.write('/api/tasks', 403, taskInput(siteId), 'viewer');
  let task = await f.write('/api/tasks', 201, { ...taskInput(siteId), verifier_id: f.demo.id });
  const path = `/api/tasks/${task.id}`;
  await f.write(path, 403, { wbsId: node.id }, 'viewer', 'PATCH');
  task = await f.write(path, 200, { wbsId: node.id }, 'demo', 'PATCH');
  t.assert.strictEqual(task.wbs_id, node.id);
  await f.write(`${path}/transition`, 200, { to: 'in_progress' }, 'editor');
  await f.write(`${path}/transition`, 200, { to: 'to_verify', note: 'Synthetic declaration.' }, 'editor');
  const waiver = { to: 'closed', waiver: true, reason: 'Synthetic review of site evidence.' };
  await f.write(`${path}/transition`, 403, waiver, 'viewer');
  await f.write(`${path}/transition`, 200, waiver);
  const other = await f.write('/api/tasks', 201, { ...taskInput(siteId), verifier_id: f.users.verifier.id });
  await f.write(`/api/tasks/${other.id}/transition`, 200, { to: 'in_progress' }, 'editor');
  await f.write(`/api/tasks/${other.id}/transition`, 200, { to: 'to_verify', note: 'Synthetic declaration.' }, 'editor');
  await f.write(`/api/tasks/${other.id}/transition`, 403, waiver);
});

test('diary entries and historical corrections work in the sandbox with retained versions', async t => {
  const f = await fixture(t);
  const day = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10);
  const input = { siteId: f.site.id, operational_date: day, shift: 'day', actual: 'Synthetic entry', motivation: 'Synthetic exercise' };
  await f.write('/api/diary', 403, input, 'viewer');
  await f.write('/api/diary', 403, input, 'editor');
  const entry = await f.write('/api/diary', 201, input);
  t.assert.strictEqual(entry.recorded_late, true);
  const path = `/api/diary/${entry.id}`;
  const update = { actual: 'Synthetic correction', motivation: 'Corrected the test entry' };
  await f.write(path, 403, update, 'viewer', 'PATCH');
  t.assert.strictEqual((await f.write(path, 200, update, 'demo', 'PATCH')).actual, update.actual);
  t.assert.strictEqual((await f.call(`${path}/versions`, 200)).length, 1);
});

test('demo progress type management includes creation, assignment, step writes and deletion', async t => {
  const f = await fixture(t), siteId = f.site.id, item = randomUUID();
  await f.db.run('INSERT INTO site_progress_items (id, site_id, description, source_row, created_at) VALUES (?, ?, ?, ?, ?)',
    item, siteId, 'Synthetic progress item', 1, stamp);
  const input = { site_id: siteId, code: 'DEMO-TYPE', name: 'Synthetic type', steps: [{ code: 'S1', position: 1, weight: 100 }] };
  await f.write('/api/progress-types', 403, input, 'editor');
  const type = await f.write('/api/progress-types', 201, input);
  const itemPath = `/api/site-progress/${item}`, typePath = `/api/progress-types/${type.id}`;
  await f.write(`${itemPath}/progress-type`, 403, { progress_type_id: type.id }, 'editor', 'PATCH');
  await f.write(`${itemPath}/progress-type`, 200, { progress_type_id: type.id }, 'demo', 'PATCH');
  const steps = { steps: [{ step_id: type.steps[0].id, percent: 40 }] };
  await f.write(`${itemPath}/steps`, 403, steps, 'viewer', 'PUT');
  t.assert.strictEqual((await f.write(`${itemPath}/steps`, 200, steps, 'demo', 'PUT')).progress_pct, 40);
  await f.call(typePath, 403, { role: 'editor', method: 'DELETE' });
  await f.call(typePath, 409, { method: 'DELETE' });
  await f.write(`${itemPath}/progress-type`, 200, { progress_type_id: null }, 'demo', 'PATCH');
  t.assert.deepStrictEqual(await f.call(typePath, 200, { method: 'DELETE' }), { deleted: true });
});

test('demo uploads and lists sandbox attachments; viewer and out-of-scope upload attempts never reach storage', async t => {
  const f = await fixture(t);
  const task = await createTask(f.db, taskInput(f.site.id));
  const outside = await createTask(f.db, taskInput(f.outside.id));
  await f.write('/api/attachments', 403, taskEvidenceInput(task.id), 'viewer');
  await f.write('/api/attachments', 403, taskEvidenceInput(outside.id));
  t.assert.deepStrictEqual(f.storage.calls, []);
  const file = await f.write('/api/attachments', 201, taskEvidenceInput(task.id));
  t.assert.strictEqual(file.uploaded_by, f.demo.id);
  t.assert.deepStrictEqual((await f.call(`/api/attachments?site_id=${f.site.id}`, 200)).map(row => row.id), [file.id]);
});

test('the demo grants every module on sandbox memberships and keeps all reads and writes site-scoped', async t => {
  const f = await fixture(t), siteId = f.site.id;
  const { members } = await f.call(`/api/member-access?site_id=${siteId}`, 200);
  t.assert.deepStrictEqual(members.map(member => member.user_id), [f.demo.id]);
  t.assert.deepStrictEqual(members[0].modules, Object.fromEntries(MODULES.map(module => [module, true])));
  const sites = [siteId, f.outside.id];
  for (const id of sites) {
    const status = id === siteId ? 200 : 403;
    for (const family of ['dashboard', 'report', 'tasks', 'diary', 'deviations', 'site-progress', 'time-bookings',
      'wbs', 'cost-impacts', 'tools', 'certifications', 'hse-events', 'purchase-orders', 'packages', 'shipments',
      'employees', 'work-days', 'audit-events', 'import-mappings']) {
      await f.call(`/api/${family}?site_id=${id}`, status);
    }
    await f.call(`/api/workforce/presence?site_id=${id}&date=2026-01-01`, status);
  }
  const employee = randomUUID(), workDay = randomUUID(), item = randomUUID(), deviation = randomUUID();
  await f.db.run('INSERT INTO employees (id, site_id, employee_no, created_at) VALUES (?, ?, ?, ?)', employee, siteId, 'DEMO-1', stamp);
  await f.db.run('INSERT INTO work_days (id, site_id, employee_id, operational_date, created_at) VALUES (?, ?, ?, ?, ?)',
    workDay, siteId, employee, '2026-01-01', stamp);
  await f.db.run('INSERT INTO site_progress_items (id, site_id, description, source_row, created_at) VALUES (?, ?, ?, ?, ?)',
    item, siteId, 'Synthetic booking item', 1, stamp);
  await f.db.run('INSERT INTO deviations (id, site_id, title, created_at) VALUES (?, ?, ?, ?)', deviation, siteId, 'Synthetic deviation', stamp);
  for (const [route, body, method = 'POST', status = 201] of [
    ['/api/tools', { site_id: siteId, name: 'Synthetic tool' }],
    ['/api/certifications', { siteId, employeeId: employee, name: 'Synthetic certification', category: 'training' }],
    ['/api/hse-events', { siteId, type: 'near_miss', severity: 'low', occurredOn: '2026-01-01' }],
    ['/api/time-bookings', { work_day_id: workDay, site_progress_item_id: item, hours: 1 }],
    ['/api/wbs', { site_id: siteId, wbs_code: 'DEMO-WBS' }],
    [`/api/deviations/${deviation}/owner`, { userId: f.demo.id }, 'PATCH', 200],
    ['/api/cost-impacts', { site_id: siteId, title: 'Synthetic impact', deviation_ids: [deviation] }],
  ]) {
    await f.write(route, 403, body, 'viewer', method);
    await f.write(route, status, body, 'demo', method);
  }
  const orderBody = { siteId, poNo: 'DEMO-PO', orderedOn: '2026-01-01', supplierName: 'Synthetic supplier' };
  await f.write('/api/purchase-orders', 403, orderBody, 'viewer');
  const order = await f.write('/api/purchase-orders', 201, orderBody);
  const line = await f.write(`/api/purchase-orders/${order.id}/items`, 201,
    { description: 'Synthetic line', materialNo: 'DEMO-MATERIAL', unit: 'piece', quantity: '2' });
  const packageBody = { siteId, purchaseOrderId: order.id, items: [{ purchaseOrderItemId: line.id, quantityPacked: '1' }] };
  await f.write('/api/packages', 403, packageBody, 'viewer');
  const pack = await f.write('/api/packages', 201, packageBody);
  const shipmentBody = { siteId, shipmentNo: 'DEMO-SHIPMENT', packageIds: [pack.id] };
  await f.write('/api/shipments', 403, shipmentBody, 'viewer');
  await f.write('/api/shipments', 201, shipmentBody);
  await f.write('/api/dashboard/layout', 200, { site_id: siteId, widgets: ['daily_pulse'] }, 'demo', 'PUT');
  await f.write('/api/dashboard/layout', 403, { site_id: f.outside.id, widgets: ['daily_pulse'] }, 'demo', 'PUT');
  t.assert.deepStrictEqual(await f.call('/api/reporting/overview', 200), { scopeIds: [] });
});

test('legacy owner rows and grants never give a demo account access to other sites or administration', async t => {
  const f = await fixture(t);
  await f.db.run("INSERT INTO site_members VALUES (?, ?, 'owner')", f.outside.id, f.demo.id);
  await f.db.run('INSERT INTO user_permissions (user_id, permission, granted_at) VALUES (?, ?, ?)', f.demo.id, INVITATION_PERMISSION, stamp);
  const outsideTask = await createTask(f.db, taskInput(f.outside.id));
  const ids = (await f.call('/api/sites', 200)).map(row => row.id);
  t.assert.deepStrictEqual(ids, [f.site.id]);
  t.assert.deepStrictEqual(await f.call('/api/tasks', 200), []);
  t.assert.deepStrictEqual(await f.call('/api/diary', 200), []);
  await f.call(`/api/tasks/${outsideTask.id}`, 403);
  await f.write('/api/tasks', 403, taskInput(f.outside.id));
  const demoScope = randomUUID(), mixedScope = randomUUID(), outsideScope = randomUUID();
  for (const [table, siteId, scope] of [
    ['hr_import_sources', f.site.id, demoScope],
    ['wbs_import_sources', f.site.id, mixedScope],
    ['wbs_import_sources', f.outside.id, mixedScope],
    ['hr_import_sources', f.outside.id, outsideScope],
  ]) {
    await f.db.run(`INSERT INTO ${table} (site_id, scope_id, run_id) VALUES (?, ?, ?)`, siteId, scope, randomUUID());
  }
  t.assert.deepStrictEqual(await f.call('/api/reporting/overview', 200), { scopeIds: [demoScope] });
  for (const family of ['employees', 'wbs', 'site-progress', 'deviations']) {
    await f.write(`/api/${family}/import`, 403, { site_id: f.site.id });
  }
  const sitePath = `/api/sites/${f.site.id}`;
  await f.call(`${sitePath}/members`, 403);
  await f.write(`${sitePath}/members`, 403, { user_id: f.demo.id, role: 'owner' });
  await f.write('/api/member-access', 403, { site_id: f.site.id, member_id: f.demo.id, module: 'tools', allowed: false }, 'demo', 'PUT');
  await f.write(sitePath, 403, { jurisdiction: 'UK' }, 'demo', 'PATCH');
  await f.write(`${sitePath}/assistant`, 403, { enabled: true }, 'demo', 'PATCH');
  await f.write(invitationPath, 403, { email: 'other@example.invalid' });
  await f.write(`${invitationPath}/${randomUUID()}/revoke`, 403);
  await t.assert.rejects(() => changePermission(f.db, 'grant', INVITATION_PERMISSION, f.demo.email), { status: 403 });
  await f.write(`${sitePath}/members`, 400, { user_id: f.demo.id, role: 'owner' }, 'owner');
  await f.call(`${sitePath}/members`, 200, { role: 'owner' });
  await f.write(sitePath, 200, { jurisdiction: 'UK' }, 'owner', 'PATCH');
});

for (const driver of ['sqlite', 'pg']) {
  test(`demo invitations activate explicit and default roles and permit a first site (${driver})`, async t => {
    const f = await fixture(t, driver);
    await changePermission(f.db, 'grant', INVITATION_PERMISSION, f.users.owner.email);
    await f.db.run("INSERT INTO site_members VALUES (?, ?, 'owner')", f.outside.id, f.users.owner.id);
    const invite = (fields, status = 201) => f.write(invitationPath, status, fields, 'owner');
    await invite({ email: 'invalid@example.invalid', cantiere_id: f.outside.id, role: 'demo_user' }, 400);
    await invite({ email: 'missing-role@example.invalid', cantiere_id: f.outside.id }, 400);
    for (const [index, [fields, expected]] of [
      [{ cantiere_id: f.site.id, role: 'demo_user' }, 'demo_user'],
      [{ cantiere_id: f.site.id }, 'demo_user'],
      [{ cantiere_id: f.site.id, role: 'owner' }, 'owner'],
      [{}, 'demo_user'],
    ].entries()) {
      const invitation = await invite({ email: `invite-${index}@example.invalid`, ...fields });
      const row = await f.db.get('SELECT site_role FROM invitations WHERE id = ?', invitation.id);
      t.assert.strictEqual(row.site_role, expected);
      const link = new URL(f.mail.at(-1).text.match(/^https:\/\/\S+$/m)[0]);
      const result = await f.request('/api/auth/activate', { method: 'POST', body: { token: link.searchParams.get('token'), password } });
      t.assert.strictEqual(result.status, 200, JSON.stringify(result.body));
      t.assert.strictEqual(Boolean(result.body.user.demo_sandbox), expected === 'demo_user');
      const role = 'invitee';
      f.cookies[role] = result.headers['set-cookie'].split(';')[0];
      const me = await f.call('/api/auth/me', 200, { role });
      t.assert.deepStrictEqual(me.roles, fields.cantiere_id ? [{ site_id: f.site.id, role: expected }] : []);
      if (!fields.cantiere_id) {
        const first = await f.write('/api/sites', 201, { code: 'TEST-FIRST', name: 'Synthetic first site' }, role);
        t.assert.deepStrictEqual((await f.call('/api/auth/me', 200, { role })).roles, [{ site_id: first.id, role: 'demo_user' }]);
      }
    }
  });

  test(`051 preserves existing data and converts only explicitly marked demo testers (${driver})`, async t => {
    const db = await database(t, driver, false);
    const files = (await readdir(new URL(`../server/migrations/${driver}/`, import.meta.url))).sort();
    await db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const file of files.filter(file => file < '051')) {
      await db.transaction(async tx => {
        await applyMigration(tx, file, { driver });
        await tx.run('INSERT INTO schema_migrations VALUES (?, ?)', file.slice(0, 3), stamp);
      });
    }
    const site = await createSite(db, { code: 'TEST-MIGRATION', name: 'Synthetic upgrade site' });
    const shared = await createUser(db, { email: 'shared@example.invalid', name: 'Synthetic shared account', password, siteCode: site.code, role: 'owner' });
    const admin = await createUser(db, { email: 'admin@example.invalid', name: 'Synthetic administrator', password, siteCode: site.code, role: 'owner' });
    await db.run('UPDATE users SET shared_demo = TRUE WHERE id = ?', shared.id);
    const invitation = randomUUID();
    await db.run(`INSERT INTO invitations (id, email, token_hash, created_by, created_at, expires_at, site_id, site_role, delivery_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'viewer', 'sent')`, invitation, 'pending@example.invalid', 'synthetic-hash',
    admin.id, stamp, '2027-01-01T00:00:00.000Z', site.id);
    const before = await db.get('SELECT * FROM invitations WHERE id = ?', invitation);
    await assertUpgrade(db, { driver, first: '051', demoSandbox: true });
    t.assert.deepStrictEqual((await memberships(db, shared.id)).map(row => ({ ...row })), [{ site_id: site.id, role: 'demo_user' }]);
    t.assert.deepStrictEqual((await memberships(db, admin.id)).map(row => ({ ...row })), [{ site_id: site.id, role: 'owner' }]);
    const after = await db.get('SELECT * FROM invitations WHERE id = ?', invitation);
    t.assert.deepStrictEqual(after, before);
    const ledger = await db.all('SELECT * FROM schema_migrations ORDER BY version');
    t.assert.strictEqual(await migrate(db, { driver, demoSandbox: true }), 0);
    await db.transaction(migrateDemoSandbox);
    t.assert.deepStrictEqual((await memberships(db, shared.id)).map(row => ({ ...row })), [{ site_id: site.id, role: 'demo_user' }]);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM schema_migrations ORDER BY version'), ledger);
    if (driver === 'sqlite') t.assert.deepStrictEqual(await db.all('PRAGMA foreign_key_check'), []);
  });
}

test('administrative CLI assignment is repeatable; resetting and reapplying demo fixtures preserve the role', async t => {
  const f = await fixture(t);
  const site = await createSite(f.db, { code: 'FITT-01', name: 'Synthetic reset fixture' });
  const args = ['--email', 'cli@example.invalid', '--name', 'Synthetic CLI tester', '--site', site.code, '--role', 'demo_user'];
  await t.assert.rejects(() => createUser(f.db, { ...parseArgs(args), password }), /sandbox site/);
  await markDemoSite(f.db, site.code);
  const created = await createUser(f.db, { ...parseArgs(args), password });
  const legacy = await createUser(f.db, { email: 'legacy@example.invalid', name: 'Synthetic legacy tester', password, siteCode: site.code, role: 'owner' });
  await t.assert.rejects(() => assignDemoUser(f.db, legacy.email, f.outside.code), { status: 400 });
  t.assert.deepStrictEqual((await memberships(f.db, legacy.id)).map(row => ({ ...row })), [{ site_id: site.id, role: 'owner' }]);
  await assignDemoUser(f.db, legacy.email);
  await assignDemoUser(f.db, legacy.email);
  await f.db.transaction(tx => applyDemo(tx, { demoSandbox: false }));
  const access = await memberships(f.db, legacy.id);
  t.assert.ok(access.length > 1);
  t.assert.ok(access.every(row => row.role === 'demo_user'));
  t.assert.ok(await f.db.transaction(resetDemo) > 0);
  await f.db.transaction(tx => applyDemo(tx, { demoSandbox: false }));
  t.assert.deepStrictEqual(await memberships(f.db, legacy.id), access);
  t.assert.deepStrictEqual(await memberships(f.db, created.id), access);
  t.assert.notStrictEqual(scopeFor('https://demo.example.invalid', legacy.id, true), scopeFor('https://demo.example.invalid', legacy.id));
});
