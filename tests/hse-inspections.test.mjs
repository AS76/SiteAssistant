import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createSite } from '../server/repository.mjs';
import { createServer } from '../server/http.mjs';
import { createHseAsset, listHseAssets, updateHseAsset, deleteHseAsset } from '../server/hse-assets.mjs';
import { createInspection, listInspections, getInspection } from '../server/hse-inspections.mjs';
import { hseSummary, listHseEvents } from '../server/hse.mjs';
import { findTemplate } from '../server/checklists.mjs';
import { listAuditEvents } from '../server/audit.mjs';
import { saveModuleAccess } from '../server/module-access.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { authFixture } from './helpers/auth.mjs';
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

for (const driver of ['sqlite', 'pg']) test(`HSE inspections ${driver === 'pg' && !isPg ? 'PGlite' : driver}`, async t => {
  const db = await database(t, driver);
  const { users, cookies } = await authFixture(db);
  const error = (status, code) => ({ status, code });
  const fixture = async (templateCode = 'it_lifting', roles = ['owner', 'editor', 'verifier', 'viewer']) => {
    const template = findTemplate(templateCode);
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic inspection site', jurisdiction: template.jurisdiction });
    for (const role of roles) await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, users[role].id, role);
    const asset = await createHseAsset(db, { siteId: site.id, name: 'Synthetic asset', code: 'ASSET-1', templateCode }, users.owner);
    const input = { siteId: site.id, assetId: asset.id, performedOn: '2026-01-31',
      performedBy: 'Example inspector', mode: 'internal', outcome: 'pass',
      items: template.items.map(({ code }) => ({ code, result: 'ok' })),
    };
    return { site, asset, template, input,
      create: (changes = {}, user = users.owner) => createInspection(db, { ...input, ...changes }, user),
      list: (changes = {}, user = users.viewer) => listInspections(db, { siteId: site.id, ...changes }, user),
    };
  };

  await t.test('stores complete snapshots in template order and trims performer text', async t => {
    const f = await fixture();
    const items = f.input.items.map((item, position) => ({ ...item,
      result: ['ok', 'not_ok', 'na'][position % 3], note: position === 0 ? ' Example note ' : null,
      label: 'Untrusted label', position: 99,
    })).reverse();
    const untrustedEventId = randomUUID();
    const row = await f.create({ items, performedBy: ' Example inspector ', performerRole: ' Competent person ',
      mode: 'external', outcome: 'pass_with_notes', notes: ' Header note ', hseEventId: untrustedEventId });
    t.assert.strictEqual(row.performed_by, 'Example inspector');
    t.assert.strictEqual(row.performer_role, 'Competent person');
    t.assert.strictEqual(row.mode, 'external');
    t.assert.strictEqual(row.outcome, 'pass_with_notes');
    t.assert.strictEqual(row.notes, 'Header note');
    t.assert.ok(row.hse_event_id);
    t.assert.notStrictEqual(row.hse_event_id, untrustedEventId);
    t.assert.ok(await db.get('SELECT id FROM hse_events WHERE id = ?', row.hse_event_id));
    t.assert.strictEqual(row.performed_on, '2026-01-31');
    t.assert.ok(Number.isFinite(Date.parse(row.created_at)));
    t.assert.strictEqual(new Date(row.updated_at).toISOString(), new Date(row.created_at).toISOString());
    const stored = await db.all('SELECT * FROM hse_inspection_items WHERE inspection_id = ? ORDER BY position', row.id);
    t.assert.strictEqual(stored.length, f.template.items.length);
    t.assert.deepStrictEqual(stored.map(item => [item.item_code, item.label, item.position, item.result]),
      f.template.items.map((item, position) => [item.code, item.label, position, ['ok', 'not_ok', 'na'][position % 3]]));
    t.assert.strictEqual(stored[0].note, 'Example note');
    t.assert.strictEqual(new Set(stored.map(item => item.id)).size, stored.length);
    t.assert.ok(await db.get('SELECT id FROM hse_inspections WHERE id = ?', row.id));
  });

  await t.test('creates linked register rows with the mode, severity and asset/template snapshot', async t => {
    const f = await fixture();
    for (const [mode, outcome, type, severity] of [
      ['internal', 'pass', 'inspection', 'low'],
      ['external', 'pass_with_notes', 'external_visit', 'medium'],
      ['internal', 'fail', 'inspection', 'high'],
    ]) {
      const row = await f.create({ mode, outcome }, users.editor);
      const events = await listHseEvents(db, { siteId: f.site.id, type }, users.verifier);
      const event = events.find(event => event.id === row.hse_event_id);
      t.assert.ok(event);
      t.assert.strictEqual(event.type, type);
      t.assert.strictEqual(event.severity, severity);
      t.assert.strictEqual(event.site_id, f.site.id);
      t.assert.strictEqual(event.occurred_on, row.performed_on);
      t.assert.strictEqual(event.notes, `${f.asset.name} — ${f.template.title}`);
      t.assert.strictEqual(event.location, f.asset.code);
      for (const field of ['event_no', 'persons_involved', 'deviation_id']) t.assert.strictEqual(event[field], null);
      t.assert.strictEqual((await getInspection(db, row.id, users.viewer)).hse_event_id, event.id);
      t.assert.strictEqual((await f.list()).find(item => item.id === row.id).hse_event_id, event.id);
      const audit = await listAuditEvents(db, { siteId: f.site.id, entityType: 'hse_event', entityId: event.id }, users.owner);
      t.assert.strictEqual(audit.length, 1);
      t.assert.strictEqual(audit[0].actor, users.editor.id);
    }
    await updateHseAsset(db, f.asset.id, { code: null }, users.owner);
    const withoutCode = await f.create();
    const event = (await listHseEvents(db, { siteId: f.site.id }, users.owner)).find(event => event.id === withoutCode.hse_event_id);
    t.assert.strictEqual(event.location, f.asset.name);
  });

  await t.test('summary includes all five types on a site with only two inspections', async t => {
    const f = await fixture(), other = await fixture();
    await f.create();
    await f.create({ mode: 'external', outcome: 'pass_with_notes' });
    await other.create({ outcome: 'fail' });
    t.assert.deepStrictEqual(await hseSummary(db, { siteId: f.site.id }, users.verifier), {
      by_type: { near_miss: 0, accident: 0, observation: 0, inspection: 1, external_visit: 1 },
      by_severity: { low: 1, medium: 1, high: 0 }, total: 2,
    });
  });

  await t.test('derives every status in order using local calendar dates and an inclusive 30-day window', async t => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    t.after(() => {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    });
    // UTC is already November 15, while the server calendar is November 14.
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-15T07:30:00Z') });
    const f = await fixture();
    const listedAsset = async () => (await listHseAssets(db, { siteId: f.site.id }, users.viewer))[0];
    const never = await listedAsset();
    t.assert.deepStrictEqual([never.lastInspectionOn, never.lastOutcome, never.nextDueOn, never.status], [null, null, null, 'never']);
    const cases = [
      ['fail', '2026-11-13', 'failed'],
      ['fail', '2027-01-01', 'failed'],
      ['pass', '2026-11-13', 'overdue'],
      ['pass', '2026-11-14', 'due_soon'],
      ['pass_with_notes', '2026-12-14', 'due_soon'],
      ['pass', '2026-12-15', 'ok'],
      ['pass', null, 'ok'],
    ];
    for (const [index, [outcome, nextDueOn, status]] of cases.entries()) {
      const performedOn = `2026-10-${String(index + 1).padStart(2, '0')}`;
      const inspection = await f.create({ performedOn, outcome, nextDueOn: nextDueOn ?? '2027-01-01' });
      // Null due dates are valid stored history even though create requires a date.
      if (nextDueOn === null) await db.run('UPDATE hse_inspections SET next_due_on = NULL WHERE id = ?', inspection.id);
      const row = await listedAsset();
      t.assert.deepStrictEqual([row.lastInspectionOn, row.lastOutcome, row.nextDueOn, row.status],
        [performedOn, outcome, nextDueOn, status]);
    }
  });

  await t.test('asset status uses performed date then creation date, independent of insertion order and other assets', async t => {
    const f = await fixture(), other = await fixture();
    const secondAsset = await createHseAsset(db, { siteId: f.site.id, name: 'Uninspected asset', templateCode: f.template.code }, users.owner);
    const latest = await f.create({ performedOn: '2026-10-02', outcome: 'fail' });
    const sameDateOlder = await f.create({ performedOn: '2026-10-02', nextDueOn: '2099-01-01' });
    await f.create({ performedOn: '2026-10-01', nextDueOn: '2099-01-01' });
    await other.create({ performedOn: '2026-10-03' });
    await db.run('UPDATE hse_inspections SET created_at = ? WHERE id = ?', '2026-10-03T01:00:00.000Z', latest.id);
    await db.run('UPDATE hse_inspections SET created_at = ? WHERE id = ?', '2026-10-03T00:00:00.000Z', sameDateOlder.id);
    const rows = await listHseAssets(db, { siteId: f.site.id }, users.viewer);
    const row = rows.find(row => row.id === f.asset.id);
    t.assert.deepStrictEqual([row.lastInspectionOn, row.lastOutcome, row.nextDueOn, row.status],
      [latest.performed_on, latest.outcome, latest.next_due_on, 'failed']);
    t.assert.strictEqual(rows.find(row => row.id === secondAsset.id).status, 'never');
    t.assert.strictEqual(rows.length, 2);
  });

  await t.test('rejects missing, duplicate, unknown and invalid results without partial data', async t => {
    const f = await fixture();
    for (const [items, code] of [
      [undefined, 'INSPECTION_ITEMS_INCOMPLETE'], [[], 'INSPECTION_ITEMS_INCOMPLETE'],
      [f.input.items.slice(1), 'INSPECTION_ITEMS_INCOMPLETE'],
      [[...f.input.items, f.input.items[0]], 'INSPECTION_ITEMS_INCOMPLETE'],
      [[...f.input.items.slice(1), f.input.items[1]], 'INSPECTION_ITEMS_INCOMPLETE'],
      [[...f.input.items, { code: 'unknown', result: 'ok' }], 'INSPECTION_ITEMS_UNKNOWN'],
      [[{ code: 'unknown', result: 'ok' }, ...f.input.items.slice(1)], 'INSPECTION_ITEMS_UNKNOWN'],
      [[{ ...f.input.items[0], result: 'bad' }, ...f.input.items.slice(1)], 'VALIDATION_ERROR'],
      [[null, ...f.input.items.slice(1)], 'VALIDATION_ERROR'],
    ]) await t.assert.rejects(() => f.create({ items }), error(400, code));
    t.assert.deepStrictEqual(await db.all('SELECT * FROM hse_inspections WHERE site_id = ?', f.site.id), []);
    t.assert.deepStrictEqual(await db.all(`SELECT i.* FROM hse_inspection_items i
      JOIN hse_inspections h ON h.id = i.inspection_id WHERE h.site_id = ?`, f.site.id), []);
    t.assert.strictEqual((await listAuditEvents(db, { siteId: f.site.id, entityType: 'hse_inspection' }, users.owner)).length, 0);
  });

  await t.test('computes month intervals with end-of-month clamping and leap years', async t => {
    for (const [template, performedOn, expected] of [
      ['it_lifting', '2026-01-31', '2028-01-31'],
      ['uk_lifting_accessories', '2026-08-31', '2027-02-28'],
      ['it_scaffolding', '2026-11-30', '2027-02-28'],
      ['uk_lifting_accessories', '2027-08-31', '2028-02-29'],
      ['it_ppe', '2028-02-29', '2029-02-28'],
    ]) {
      const f = await fixture(template);
      t.assert.strictEqual((await f.create({ performedOn })).next_due_on, expected);
    }
  });

  await t.test('respects and validates supplied nextDueOn and nextOn dates', async t => {
    const f = await fixture();
    for (const field of ['nextDueOn', 'nextOn']) {
      const row = await f.create({ [field]: '2030-02-28' });
      t.assert.strictEqual(row.next_due_on, '2030-02-28');
      t.assert.strictEqual((await getInspection(db, row.id, users.viewer)).next_due_on, '2030-02-28');
      for (const value of [null, '', '2027-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '2026-01-01T00:00:00Z', 20260101]) {
        await t.assert.rejects(() => f.create({ [field]: value }), error(400, 'VALIDATION_ERROR'));
      }
    }
    await t.assert.rejects(() => f.create({ nextOn: '2030-02-28', nextDueOn: '2030-03-01' }), error(400, 'VALIDATION_ERROR'));
    t.assert.strictEqual((await f.create({ nextOn: '2030-02-28', nextDueOn: '2030-02-28' })).next_due_on, '2030-02-28');
  });

  await t.test('validates required fields, calendar dates, enums, text types and identifiers', async t => {
    const f = await fixture();
    for (const changes of [
      { performedOn: null }, { performedOn: '2026-02-29' }, { performedOn: '2026-04-31' },
      { performedOn: '2026-1-01' }, { performedOn: '0000-01-01' }, { performedOn: 'invalid' },
      { performedBy: null }, { performedBy: '' }, { performedBy: '  ' }, { performedBy: 42 },
      { performedBy: 'x'.repeat(201) }, { mode: 'other' }, { mode: null }, { outcome: 'other' },
      { outcome: null }, { performerRole: [] }, { notes: 42 },
      { items: f.input.items.map(item => ({ ...item, note: 42 })) },
      { siteId: undefined }, { siteId: 'bad' }, { assetId: undefined }, { assetId: 'bad' },
    ]) await t.assert.rejects(() => f.create(changes), error(400, 'VALIDATION_ERROR'));
    for (const input of [null, [], 'invalid']) {
      await t.assert.rejects(() => createInspection(db, input, users.owner), error(400, 'VALIDATION_ERROR'));
    }
    t.assert.strictEqual((await f.create({ performedBy: ` ${'x'.repeat(200)} `, outcome: 'fail', performedOn: '2028-02-29' })).performed_by.length, 200);
    await t.assert.rejects(() => f.list({ siteId: 'bad' }), error(400, 'VALIDATION_ERROR'));
    await t.assert.rejects(() => f.list({ assetId: '' }), error(400, 'VALIDATION_ERROR'));
    await t.assert.rejects(() => getInspection(db, 'bad', users.viewer), error(400, 'VALIDATION_ERROR'));
    await t.assert.rejects(() => getInspection(db, randomUUID(), users.viewer), error(404, 'INSPECTION_NOT_FOUND'));
  });

  await t.test('rejects foreign, missing and soft-deleted assets for create and filtering', async t => {
    const f = await fixture(), other = await fixture();
    const historical = await f.create();
    await deleteHseAsset(db, f.asset.id, users.owner);
    for (const assetId of [other.asset.id, randomUUID(), f.asset.id]) {
      await t.assert.rejects(() => f.create({ assetId }), error(404, 'ASSET_NOT_FOUND'));
      await t.assert.rejects(() => f.list({ assetId }), error(404, 'ASSET_NOT_FOUND'));
    }
    t.assert.strictEqual((await getInspection(db, historical.id, users.viewer)).id, historical.id);
    t.assert.strictEqual((await getInspection(db, historical.id, users.viewer)).hse_event_id, historical.hse_event_id);
    t.assert.deepStrictEqual((await f.list()).map(row => row.id), [historical.id]);
    const events = await listHseEvents(db, { siteId: f.site.id }, users.owner);
    t.assert.deepStrictEqual(events.map(row => row.id), [historical.hse_event_id]);
    t.assert.deepStrictEqual(await listHseAssets(db, { siteId: f.site.id }, users.viewer), []);
  });

  await t.test('enforces owner/editor writes and member reads, rejects non-members', async t => {
    const f = await fixture();
    const row = await f.create({}, users.editor);
    for (const role of ['viewer', 'verifier']) {
      await t.assert.rejects(() => f.create({}, users[role]), error(403, 'FORBIDDEN'));
    }
    for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
      t.assert.deepStrictEqual((await f.list({}, users[role])).map(item => item.id), [row.id]);
      t.assert.strictEqual((await getInspection(db, row.id, users[role])).id, row.id);
    }
    const restricted = await fixture('it_lifting', ['owner']);
    const other = await restricted.create();
    for (const call of [
      () => restricted.create({}, users.verifier), () => restricted.list({}, users.verifier),
      () => getInspection(db, other.id, users.verifier),
    ]) await t.assert.rejects(call, error(403, 'FORBIDDEN'));
    for (const call of [() => f.create({}, null), () => f.list({}, null), () => getInspection(db, row.id, null)]) {
      await t.assert.rejects(call, error(401, 'UNAUTHENTICATED'));
    }
  });

  await t.test('HSE module gate blocks all three operations', async t => {
    const f = await fixture(), row = await f.create();
    await saveModuleAccess(db, { siteId: f.site.id, memberId: users.editor.id, module: 'hse', allowed: false }, users.owner);
    for (const call of [
      () => f.create({}, users.editor), () => f.list({}, users.editor),
      () => getInspection(db, row.id, users.editor),
    ]) await t.assert.rejects(call, error(403, 'MODULE_FORBIDDEN'));
    t.assert.strictEqual((await f.list()).length, 1);
  });

  await t.test('lists only the requested site and asset, ordered by performed date then creation', async t => {
    const f = await fixture(), other = await fixture();
    const secondAsset = await createHseAsset(db, { siteId: f.site.id, name: 'Second asset', templateCode: f.template.code }, users.owner);
    const older = await f.create({ performedOn: '2026-01-01' });
    const sameDateOlder = await f.create({ performedOn: '2026-02-01' });
    const sameDateNewer = await f.create({ performedOn: '2026-02-01' });
    const differentAsset = await f.create({ assetId: secondAsset.id, performedOn: '2026-03-01' });
    await other.create({ performedOn: '2027-01-01' });
    await db.run('UPDATE hse_inspections SET created_at = ? WHERE id = ?', '2026-04-01T00:00:00.000Z', sameDateOlder.id);
    await db.run('UPDATE hse_inspections SET created_at = ? WHERE id = ?', '2026-04-02T00:00:00.000Z', sameDateNewer.id);
    t.assert.deepStrictEqual((await f.list()).map(row => row.id), [differentAsset.id, sameDateNewer.id, sameDateOlder.id, older.id]);
    t.assert.deepStrictEqual((await f.list({ assetId: f.asset.id.toUpperCase() })).map(row => row.id), [sameDateNewer.id, sameDateOlder.id, older.id]);
    t.assert.deepStrictEqual(await f.list({ assetId: (await createHseAsset(db, { siteId: f.site.id,
      name: 'Uninspected asset', templateCode: f.template.code }, users.owner)).id }), []);
  });

  await t.test('get returns ordered stored items and the asset summary after a template change', async t => {
    const f = await fixture(), row = await f.create({ items: [...f.input.items].reverse() });
    // Give the first item a later position to prove the query orders stored positions.
    await db.run('UPDATE hse_inspection_items SET position = ? WHERE id = ?', 99, row.items[0].id);
    await updateHseAsset(db, f.asset.id, { templateCode: 'it_ppe' }, users.owner);
    const detail = await getInspection(db, row.id, users.viewer);
    t.assert.deepStrictEqual({ ...detail.asset }, { id: f.asset.id, name: f.asset.name, code: f.asset.code, template_code: 'it_ppe' });
    t.assert.deepStrictEqual(detail.items.map(item => item.position), [...f.template.items.slice(1).map((_, index) => index + 1), 99]);
    t.assert.deepStrictEqual(detail.items.map(item => item.label), [...f.template.items.slice(1), f.template.items[0]].map(item => item.label));
  });

  await t.test('create appends an audit row with the actor and persisted header', async t => {
    const f = await fixture(), row = await f.create({}, users.editor);
    const events = await listAuditEvents(db, { siteId: f.site.id, entityType: 'hse_inspection', entityId: row.id }, users.owner);
    t.assert.strictEqual(events.length, 1);
    t.assert.strictEqual(events[0].actor, users.editor.id);
    t.assert.strictEqual(events[0].action, 'create');
    const changes = JSON.parse(events[0].changes);
    t.assert.strictEqual(changes.id, row.id);
    t.assert.strictEqual(changes.asset_id, f.asset.id);
    t.assert.strictEqual(changes.performed_on, row.performed_on);
    t.assert.strictEqual(changes.next_due_on, row.next_due_on);
    t.assert.strictEqual(changes.hse_event_id, row.hse_event_id);
    t.assert.ok(!Object.hasOwn(changes, 'asset'));
  });

  await t.test('event, item and audit failures roll back the register row, header, items and audit', async t => {
    const f = await fixture();
    const counts = async () => Promise.all(['hse_events', 'hse_inspections', 'hse_inspection_items', 'audit_events']
      .map(async table => Number((await db.get(`SELECT COUNT(*) AS total FROM ${table}`)).total)));
    const before = await counts();
    for (const failure of ['event', 'item', 'event audit', 'inspection audit']) {
      let inserted = 0;
      const failing = { transaction: fn => db.transaction(tx => fn({ ...tx,
        get: (sql, ...values) => {
          if (failure === 'event' && sql.startsWith('INSERT INTO hse_events')) throw new Error('Synthetic event failure');
          if (failure === 'item' && sql.startsWith('INSERT INTO hse_inspection_items') && ++inserted === 2) {
            throw new Error('Synthetic item failure');
          }
          return tx.get(sql, ...values);
        },
        run: (sql, ...values) => {
          if (sql.startsWith('INSERT INTO audit_events') &&
            ((failure === 'event audit' && values[2] === 'hse_event') ||
              (failure === 'inspection audit' && values[2] === 'hse_inspection'))) throw new Error('Synthetic audit failure');
          return tx.run(sql, ...values);
        },
      })) };
      await t.assert.rejects(() => createInspection(failing, f.input, users.owner), /Synthetic (event|item|audit) failure/);
      t.assert.deepStrictEqual(await counts(), before);
    }
  });

  await t.test('migration enforces enums, foreign keys, unique codes and the lookup index', async t => {
    const f = await fixture(), row = await f.create();
    t.assert.strictEqual(await migrate(db, { driver }), 0);
    for (const [column, value] of [['mode', 'bad'], ['outcome', 'bad']]) {
      await t.assert.rejects(() => db.run(`UPDATE hse_inspections SET ${column} = ? WHERE id = ?`, value, row.id), /check/i);
    }
    for (const column of ['site_id', 'asset_id']) {
      await t.assert.rejects(() => db.run(`UPDATE hse_inspections SET ${column} = ? WHERE id = ?`, randomUUID(), row.id), /foreign key/i);
    }
    const item = row.items[0];
    await t.assert.rejects(() => db.run('UPDATE hse_inspection_items SET result = ? WHERE id = ?', 'bad', item.id), /check/i);
    await t.assert.rejects(() => db.run('UPDATE hse_inspection_items SET inspection_id = ? WHERE id = ?', randomUUID(), item.id), /foreign key/i);
    await t.assert.rejects(() => db.run(`INSERT INTO hse_inspection_items
      (id, inspection_id, item_code, label, result, position) VALUES (?, ?, ?, ?, 'ok', 0)`,
    randomUUID(), row.id, item.item_code, item.label), /unique/i);
    if (driver === 'sqlite') {
      t.assert.deepStrictEqual((await db.all('PRAGMA index_info(hse_inspections_site_asset_performed)')).map(row => row.name), ['site_id', 'asset_id', 'performed_on']);
    } else {
      const index = await db.get("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'hse_inspections_site_asset_performed'");
      t.assert.match(index.indexdef, /\(site_id, asset_id, performed_on\)/);
      const columns = await db.all("SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'hse_inspections'");
      for (const [name, type] of [['id', 'uuid'], ['site_id', 'uuid'], ['asset_id', 'uuid'], ['performed_on', 'date'],
        ['next_due_on', 'date'], ['hse_event_id', 'uuid'], ['created_at', 'timestamptz'], ['updated_at', 'timestamptz']]) {
        t.assert.strictEqual(columns.find(row => row.column_name === name).udt_name, type);
      }
    }
  });

  await t.test('HTTP create, list, detail, validation, role matrix and module gates over a real socket', async t => {
    const server = createServer(db);
    t.after(async () => {
      if (server.listening) await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    });
    // Socket admission errors must fail visibly without an in-process substitute.
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (path, { method = 'GET', body, role = 'owner' } = {}) => {
      const response = await fetch(`${base}${path}`, { method,
        headers: { ...(role ? { cookie: cookies[role] } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    const f = await fixture(), other = await fixture(), restricted = await fixture('it_lifting', ['owner']);
    const path = '/api/hse/inspections';
    const created = await api(path, { method: 'POST', body: f.input, role: 'editor' });
    t.assert.strictEqual(created.status, 201);
    const id = created.body.id;
    t.assert.strictEqual(created.body.items.length, f.template.items.length);
    t.assert.strictEqual(created.body.next_due_on, '2028-01-31');
    t.assert.ok(created.body.hse_event_id);
    const assets = await api(`/api/hse/assets?siteId=${f.site.id}`, { role: 'viewer' });
    t.assert.strictEqual(assets.status, 200);
    t.assert.deepStrictEqual([assets.body[0].lastInspectionOn, assets.body[0].lastOutcome, assets.body[0].nextDueOn],
      ['2026-01-31', 'pass', '2028-01-31']);
    t.assert.ok(['ok', 'due_soon', 'overdue'].includes(assets.body[0].status));
    const register = await api(`/api/hse-events?siteId=${f.site.id}&type=inspection`, { role: 'verifier' });
    t.assert.strictEqual(register.status, 200);
    t.assert.deepStrictEqual(register.body.map(row => row.id), [created.body.hse_event_id]);
    const summary = await api(`/api/hse-events?siteId=${f.site.id}&summary=1`, { role: 'verifier' });
    t.assert.strictEqual(summary.status, 200);
    t.assert.deepStrictEqual(summary.body.by_type, { near_miss: 0, accident: 0, observation: 0, inspection: 1, external_visit: 0 });
    const listed = await api(`${path}?siteId=${f.site.id}&assetId=${f.asset.id}`, { role: 'viewer' });
    t.assert.strictEqual(listed.status, 200);
    t.assert.deepStrictEqual(listed.body.map(row => row.id), [id]);
    const detail = await api(`${path}/${id}`, { role: 'viewer' });
    t.assert.strictEqual(detail.status, 200);
    t.assert.deepStrictEqual(detail.body.items.map(item => item.position), f.template.items.map((_, index) => index));
    t.assert.deepStrictEqual(detail.body.asset, { id: f.asset.id, name: f.asset.name, code: f.asset.code, template_code: f.asset.template_code });
    const privateRow = await restricted.create();
    for (const [url, method, body, role, status, code] of [
      [path, 'POST', f.input, 'viewer', 403, 'FORBIDDEN'],
      [path, 'POST', f.input, 'verifier', 403, 'FORBIDDEN'],
      [path, 'POST', restricted.input, 'verifier', 403, 'FORBIDDEN'],
      [`${path}?siteId=${restricted.site.id}`, 'GET', undefined, 'verifier', 403, 'FORBIDDEN'],
      [`${path}/${privateRow.id}`, 'GET', undefined, 'verifier', 403, 'FORBIDDEN'],
      [path, 'POST', { ...f.input, siteId: undefined }, 'owner', 400, 'VALIDATION_ERROR'],
      [path, 'POST', { ...f.input, items: [] }, 'owner', 400, 'INSPECTION_ITEMS_INCOMPLETE'],
      [path, 'POST', { ...f.input, assetId: other.asset.id }, 'owner', 404, 'ASSET_NOT_FOUND'],
      [path, 'POST', { ...f.input, nextOn: '2027-02-29' }, 'owner', 400, 'VALIDATION_ERROR'],
      [`${path}?siteId=${f.site.id}&assetId=${other.asset.id}`, 'GET', undefined, 'owner', 404, 'ASSET_NOT_FOUND'],
      [`${path}?siteId=${f.site.id}`, 'GET', undefined, null, 401, 'AUTH_REQUIRED'],
    ]) {
      const response = await api(url, { method, body, role });
      t.assert.strictEqual(response.status, status, `${method} ${url}`);
      t.assert.strictEqual(response.body.code, code);
    }
    await saveModuleAccess(db, { siteId: f.site.id, memberId: users.editor.id, module: 'hse', allowed: false }, users.owner);
    for (const [url, method, body] of [[path, 'POST', f.input], [`${path}?siteId=${f.site.id}`, 'GET'], [`${path}/${id}`, 'GET']]) {
      const response = await api(url, { method, body, role: 'editor' });
      t.assert.strictEqual(response.status, 403);
      t.assert.strictEqual(response.body.code, 'MODULE_FORBIDDEN');
    }
  });
});
