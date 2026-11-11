import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createSite } from '../server/repository.mjs';
import { createServer } from '../server/http.mjs';
import { parseFamily, diffFamily, applyFamily, previewToken, verifyPreviewToken, MAX_IMPORT_BYTES, resolveMapping, DEFAULT_IDENTITIES, importRequest, saveImportMapping } from '../server/planning-import.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { isPg, openTestDb, openSqliteTestDb } from './helpers/db.mjs';
import { wbsDatabase } from './helpers/wbs.mjs';
import { applyMigration } from '../server/migrations/index.mjs';

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = buffer => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

function zip(parts) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(parts)) {
    const data = Buffer.from(content, 'utf8');
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuffer.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuffer, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);
    offset += 30 + nameBuffer.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10); end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const column = index => {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
};
function xlsx(header, rows) {
  return zip({ 'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${[header, ...rows].map((row, r) =>
    `<row r="${r + 1}">${row.map((value, c) => value == null ? '' :
      `<c r="${column(c)}${r + 1}" t="str"><v>${escape(value)}</v></c>`).join('')}</row>`).join('')}</sheetData></worksheet>` });
}
const samples = {
  employees: { header: ['Employee No', 'First Name', 'Last Name', 'Hire Date'], rows: [['E-1', 'Synthetic', 'Employee', '2026-01-15']] },
  work_days: { header: ['Date', 'Employee No', 'Start Time', 'Finish Time', 'Work Time', 'Open Hours', 'Booked Hours', 'Status'],
    rows: [['2026-07-15 00:00:00', 'E-1', '08:00', '17:00', '7,5', '', '0', ' Uninterpreted ']] },
  time_schedule: { header: ['Time Schedule Item No', 'Description', 'Level', 'Summary Task', 'Progress %', 'Planned Start'],
    rows: [['1.1', 'Synthetic child', '9', 'False', '5,5', '2026-07-15 08:30:00'], ['1', 'Synthetic root', '7', 'True', '', '2026-01-15 08:30:00'], ['7.1', 'Synthetic orphan', '0', 'False', '0', '']] },
  site_progress_items: { header: ['Description', 'Planned Start', 'Planned Finish', 'PLC-Area', 'Section', 'Progress %', 'Has Files'],
    rows: [['Synthetic item', '2026-01-15 08:30:00', '2026-07-15 08:30:00', 'A', 'S', '25,5', 'False'],
      ['Synthetic item', '2026-01-15 08:30:00', '2026-07-15 08:30:00', 'A', 'S', '50', 'True']] },
  deviations: { header: ['Deviation No', 'Title', 'Deviation Status', 'Actual Cost', 'Due Date'],
    rows: [['D-1', 'Synthetic issue', '03 Work In Progress', '', '2026-01-15 08:30:00']] },
  daily_log: { header: ['Date', 'Plan', 'Actual', 'Impediments', 'Next Step'],
    rows: [['2026-01-15 00:00:00', 'Synthetic plan', 'Synthetic execution', '', 'Synthetic follow-up']] },
};
const table = { employees: 'employees', work_days: 'work_days', time_schedule: 'project_structure', site_progress_items: 'site_progress_items', deviations: 'deviations', daily_log: 'diary' };
const parsed = (family, sample = samples[family]) => parseFamily(xlsx(sample.header, sample.rows), family);
const errorCode = code => error => error.code === code;

test('planning parser: fixed mappings, calendar values, UTC, nulls, flags and hierarchy', () => {
  const employee = parsed('employees').rows[0];
  assert.equal(employee.values.hire_date, '2026-01-15');
  const work = parsed('work_days').rows[0].values;
  assert.equal(work.work_time, 7.5); assert.equal(work.open_hours, null); assert.equal(work.booked_hours, 0);
  assert.equal(work.operational_date, '2026-07-15'); assert.equal(work.start_time, '08:00:00');
  assert.equal(work.source_status, ' Uninterpreted ');
  const wbs = parsed('time_schedule').rows;
  assert.equal(wbs[0].key, '1'); assert.equal(wbs[0].values.level, 0);
  assert.equal(wbs[0].values.planned_start, '2026-01-15T07:30:00.000000Z');
  assert.equal(wbs[1].values.planned_start, '2026-07-15T06:30:00.000000Z');
  assert.equal(wbs[0].values.summary_task, true); assert.equal(wbs[1].values.summary_task, false);
  assert.equal(wbs[2].warnings[0].code, 'ORPHAN_ROOT');
  const progress = parsed('site_progress_items').rows;
  assert.equal(progress[1].identity_state, 'unresolved'); assert.equal(progress[1].warnings[0].code, 'UNRESOLVED_IDENTITY');
  assert.notEqual(progress[0].key, progress[1].key); assert.equal(progress[0].values.progress_pct, 25.5);
  const deviation = parsed('deviations').rows[0].values;
  assert.equal(deviation.status, 'in_progress'); assert.equal(deviation.actual_cost, null);
  assert.equal(parsed('daily_log').rows[0].values.shift, 'day');
  assert.equal(parseFamily(xlsx(['Time Schedule Item No', 'Planned Hours'], [['1', '1,5e2']]), 'time_schedule').rows[0].values.planned_hours, 150);
});

test('planning parser: explicit rejection reasons and empty/invalid input', () => {
  assert.throws(() => parseFamily(Buffer.alloc(0), 'employees'), errorCode('EMPTY_FILE'));
  assert.throws(() => parseFamily(Buffer.from('invalid'), 'unknown'), errorCode('UNKNOWN_FAMILY'));
  assert.throws(() => parseFamily(Buffer.from('invalid'), 'employees'), errorCode('INVALID_XLSX'));
  assert.throws(() => parseFamily(xlsx(['Other'], [['a']]), 'employees'), errorCode('MISSING_COLUMNS'));
  assert.throws(() => parseFamily(xlsx(['Employee No'], []), 'employees'), errorCode('EMPTY_FILE'));
  assert.throws(() => parseFamily(Buffer.alloc(MAX_IMPORT_BYTES + 1), 'employees'), errorCode('FILE_TOO_LARGE'));
  const bad = parseFamily(xlsx(['Deviation No', 'Deviation Status'], [['D-1', '02 Unknown'], ['', '01 Open']]), 'deviations');
  assert.deepEqual(bad.rejected.map(row => row.rejected), ['UNKNOWN_STATUS', 'MISSING_VALUE']);
  const days = parseFamily(xlsx(['Date'], [['2026-01-15'], ['2026-01-15 12:00:00']]), 'daily_log');
  assert.equal(days.rows.length, 1); assert.equal(days.rejected[0].rejected, 'DUPLICATE_DAY');
  const statuses = ['01 Open', '03 Work In Progress', '04 Work Completed', '05 Closed', '06 Rejected'];
  assert.deepEqual(parseFamily(xlsx(['Deviation No', 'Deviation Status'], statuses.map((s, i) => [`D-${i}`, s])), 'deviations')
    .rows.map(row => row.values.status), ['open', 'in_progress', 'work_completed', 'closed', 'rejected']);
  for (const wall of ['2026-03-29 02:30:00', '2026-10-25 02:30:00', '2026-02-30 00:00:00']) {
    assert.equal(parseFamily(xlsx(['Time Schedule Item No', 'Planned Start'], [['1', wall]]), 'time_schedule').rejected[0].rejected, 'INVALID_DATE');
  }
  assert.equal(parseFamily(xlsx(['Time Schedule Item No', 'Progress %'], [['1', 'invalid']]), 'time_schedule').rejected[0].rejected, 'INVALID_NUMBER');
});

const customMapping = (family, aliases, identity = DEFAULT_IDENTITIES[family]) => resolveMapping(family,
  { aliases_json: JSON.stringify(aliases), identity_json: JSON.stringify(identity) });

test('planning mappings: defaults retain historical keys and all six parser results', () => {
  const expectedKeys = { employees: 'E-1', work_days: '["2026-07-15","E-1"]', time_schedule: '1',
    deviations: 'D-1', daily_log: '["2026-01-15","day"]' };
  for (const family of Object.keys(samples)) {
    const sample = samples[family], buffer = xlsx(sample.header, sample.rows);
    const result = parseFamily(buffer, family);
    assert.deepEqual(result, parseFamily(buffer, family, { mapping: resolveMapping(family, null) }));
    assert.deepEqual(result, parseFamily(buffer, family, { mapping: customMapping(family, {}) }));
    if (family in expectedKeys) assert.equal(result.rows[0].key, expectedKeys[family]);
  }
  const progressKey = JSON.stringify([JSON.stringify(['synthetic item', '2026-01-15t07:30:00.000000z',
    '2026-07-15t06:30:00.000000z', 'a', 's']), 1]);
  assert.equal(parsed('site_progress_items').rows[0].key, progressKey);
});

test('planning mappings: aliases replace mandatory headers and reuse field normalizers', () => {
  const sample = samples.work_days, mapping = customMapping('work_days', { operational_date: ['Working date'], employee_no: ['Worker'], work_time: ['Hours'] });
  const header = sample.header.map(name => ({ Date: 'Working date', 'Employee No': 'Worker', 'Work Time': 'Hours' })[name] || name);
  assert.deepEqual(parseFamily(xlsx(header, sample.rows), 'work_days', { mapping }), parsed('work_days'));
  const deviations = customMapping('deviations', { status: ['State'] });
  assert.equal(parseFamily(xlsx(['Deviation No', 'State'], [['D-1', '05 Closed']]), 'deviations', { mapping: deviations }).rows[0].values.status, 'closed');
  const blankCanonical = parseFamily(xlsx(['Deviation No', 'Deviation Status', 'State'], [['D-1', '', '05 Closed']]),
    'deviations', { mapping: deviations });
  assert.equal(blankCanonical.rows[0].values.status, 'closed');
  const progress = customMapping('site_progress_items', { description: ['Item'] }, ['description']);
  const input = xlsx(['Item', 'Planned Start', 'Planned Finish', 'PLC-Area', 'Section'], [['Synthetic', null, null, null, null]]);
  assert.equal(parseFamily(input, 'site_progress_items', { mapping: progress }).rows.length, 1);
  const special = customMapping('employees', { employee_no: ['__proto__'] });
  const missingSpecial = parseFamily(xlsx(['Employee No', 'First Name'], [[null, 'Synthetic']]), 'employees', { mapping: special });
  assert.equal(missingSpecial.rejected[0].rejected, 'MISSING_VALUE');
  const presentSpecial = parseFamily(xlsx(['__proto__', 'First Name'], [['E-1', 'Synthetic']]), 'employees', { mapping: special });
  assert.equal(presentSpecial.rows[0].values.employee_no, 'E-1');
  const conflicting = parseFamily(xlsx(['Employee No', 'Worker'], [['E-1', 'E-2']]), 'employees',
    { mapping: customMapping('employees', { employee_no: ['Worker'] }) });
  assert.equal(conflicting.rejected[0].rejected, 'AMBIGUOUS_COLUMNS');
});

test('planning mappings: ordered normalized identity and progress occurrences are configurable', () => {
  const sample = samples.employees, buffer = xlsx(sample.header, sample.rows);
  const mapping = customMapping('employees', {}, ['first_name', 'employee_no']);
  assert.equal(parseFamily(buffer, 'employees', { mapping }).rows[0].key, '["Synthetic","E-1"]');
  assert.equal(parseFamily(buffer, 'employees', { mapping: customMapping('employees', {}, ['employee_no', 'first_name']) }).rows[0].key, '["E-1","Synthetic"]');
  const progress = samples.site_progress_items;
  const result = parseFamily(xlsx(progress.header, progress.rows), 'site_progress_items',
    { mapping: customMapping('site_progress_items', {}, ['progress_pct']) });
  assert.deepEqual(result.rows.map(row => JSON.parse(row.key)), [['[25.5]', 1], ['[50]', 1]]);
  assert.deepEqual(result.rows.map(row => row.identity_state), ['observed', 'observed']);
  const repeated = parseFamily(xlsx(progress.header, progress.rows), 'site_progress_items',
    { mapping: customMapping('site_progress_items', {}, ['description']) });
  assert.equal(repeated.rows[1].identity_state, 'unresolved');
  assert.throws(() => parseFamily(xlsx(['Employee No'], [['E-1']]), 'employees', { mapping }), errorCode('MISSING_COLUMNS'));
});

test('planning mappings: a mapping change invalidates a token even when the parsed rows are unchanged', () => {
  const sample = samples.employees, buffer = xlsx(sample.header, sample.rows);
  const binding = { buffer, family: 'employees', siteId: randomUUID(), ...parsed('employees') };
  const token = previewToken(binding);
  const mapping = customMapping('employees', { employee_no: ['Unused alias'] });
  assert.deepEqual(parseFamily(buffer, 'employees', { mapping }), parsed('employees'));
  assert.throws(() => verifyPreviewToken(token, { ...binding, mapping }), errorCode('PREVIEW_MISMATCH'));
  assert.throws(() => verifyPreviewToken(token, { ...binding, mapping: customMapping('employees', {}, ['first_name']) }), errorCode('PREVIEW_MISMATCH'));
});

test('planning token: signature, normalized rows, scope, family, file and fifteen-minute expiry', () => {
  const f = samples.employees, buffer = xlsx(f.header, f.rows), binding = { buffer, family: 'employees', siteId: randomUUID(), ...parsed('employees') };
  const token = previewToken(binding, { now: 1000 });
  verifyPreviewToken(token, binding, { now: 2000 });
  assert.throws(() => verifyPreviewToken(token, binding, { now: 901000 }), errorCode('PREVIEW_EXPIRED'));
  for (const altered of [{ buffer: Buffer.from('tampered') }, { family: 'deviations' }, { siteId: randomUUID() },
    { rows: [{ ...binding.rows[0], values: { employee_no: 'E-2' } }] }, { timeZone: 'UTC' }]) {
    assert.throws(() => verifyPreviewToken(token, { ...binding, ...altered }, { now: 2000 }), errorCode('PREVIEW_MISMATCH'));
  }
  assert.throws(() => verifyPreviewToken(`${token.slice(0, -5)}aaaaa`, binding, { now: 2000 }), errorCode('PREVIEW_MISMATCH'));
});

for (const driver of ['sqlite', 'pg']) test(`planning import ${driver}: preview, apply and isolation`, async t => {
  let db;
  if (driver === 'pg' && !isPg) db = await wbsDatabase(t, driver);
  else {
    const database = await (driver === 'sqlite' ? openSqliteTestDb() : openTestDb());
    db = database.db; t.after(database.close);
  }
  const auth = await authFixture(db), api = requestListener(createServer(db));
  const fixture = async () => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic import site' });
    for (const [role, user] of Object.entries(auth.users)) await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, user.id, role);
    return site;
  };
  const call = (action, body, role = 'owner') => api(`/api/import/${action}`, { method: 'POST', body, cookie: auth.cookies[role] });
  const body = (site, family, sample = samples[family]) => ({ site_id: site.id, family, filename: 'synthetic.xlsx', data_base64: xlsx(sample.header, sample.rows).toString('base64') });
  const apply = async (site, family, sample = samples[family], role = 'editor') => {
    const input = body(site, family, sample), preview = await call('preview', input, role);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const result = await call('apply', { ...input, preview_token: preview.body.preview_token }, role);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { preview: preview.body, result: result.body };
  };

  await t.test('optional progress planned hours aliases import, repeat without duplication and preserve absent hours', async () => {
    const site = await fixture(), sample = { ...samples.site_progress_items,
      rows: samples.site_progress_items.rows.map(row => [...row.slice(0, -1), 'False']) };
    for (const header of ['Planned Hours', 'Planned Hours Total']) {
      const input = { header: [...sample.header, header], rows: sample.rows.map(row => [...row, '120,5']) };
      const parsed = parseFamily(xlsx(input.header, input.rows), 'site_progress_items');
      assert.deepEqual(parsed.rows.map(row => row.values.planned_hours), [120.5, 120.5]);
      assert.deepEqual(parsed.unmapped_columns, []);
      await apply(site, 'site_progress_items', input);
    }
    await apply(site, 'site_progress_items', sample);
    const rows = await db.all('SELECT planned_hours FROM site_progress_items WHERE site_id = ?', site.id);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => Number(row.planned_hours)), [120.5, 120.5]);
  });

  for (const family of Object.keys(samples)) await t.test(`${family}: add, unchanged, update, no deletion`, async () => {
    const site = await fixture();
    if (family === 'work_days') await apply(site, 'employees');
    const input = body(site, family), preview = await call('preview', input);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.counts.added, samples[family].rows.length);
    assert.equal(Number((await db.get(`SELECT COUNT(*) AS n FROM ${table[family]} WHERE site_id = ?`, site.id)).n), 0);
    const first = await call('apply', { ...input, preview_token: preview.body.preview_token });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const before = await db.all(`SELECT * FROM ${table[family]} WHERE site_id = ? ORDER BY id`, site.id);
    const second = await call('apply', { ...input, preview_token: preview.body.preview_token });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.counts.added, 0); assert.equal(second.body.counts.updated, 0);
    assert.equal(second.body.counts.unchanged, samples[family].rows.length);
    assert.deepEqual(second.body.applied_keys, []);
    assert.deepEqual(await db.all(`SELECT * FROM ${table[family]} WHERE site_id = ? ORDER BY id`, site.id), before);
    const audit = await db.get('SELECT * FROM planning_import_runs WHERE id = ?', first.body.import_run_id);
    assert.equal(audit.site_id, site.id); assert.deepEqual(Buffer.from(audit.file_data), Buffer.from(input.data_base64, 'base64'));
    if (family === 'time_schedule') {
      const nodes = await db.all('SELECT * FROM project_structure WHERE site_id = ?', site.id);
      assert.equal(nodes.find(r => r.wbs_code === '1.1').parent_id, nodes.find(r => r.wbs_code === '1').id);
      assert.equal(nodes.find(r => r.wbs_code === '7.1').parent_id, null);
    }
    if (family === 'site_progress_items') {
      assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM planning_import_keys WHERE site_id = ? AND identity_state = 'unresolved'", site.id)).n), 1);
    }
    const sample = structuredClone(samples[family]);
    const updateColumn = { employees: 'First Name', work_days: 'Work Time', time_schedule: 'Description', site_progress_items: 'Progress %', deviations: 'Title', daily_log: 'Plan' }[family];
    sample.rows[0][sample.header.indexOf(updateColumn)] = ['work_days', 'site_progress_items'].includes(family) ? '18,5' : 'Synthetic revised';
    const updated = await apply(site, family, sample);
    assert.equal(updated.preview.counts.updated, 1); assert.equal(updated.result.counts.updated, 1);
    const empty = await diffFamily(db, { siteId: site.id, family, rows: [] });
    assert.equal(empty.removed.count, samples[family].rows.length);
    const noDelete = await applyFamily(db, { siteId: site.id, family, rows: [], user: auth.users.owner });
    assert.equal(noDelete.counts.removed, 0);
    assert.equal(Number((await db.get(`SELECT COUNT(*) AS n FROM ${table[family]} WHERE site_id = ?`, site.id)).n), samples[family].rows.length);
  });

  await t.test('mapping API: alias import, identity changes, token invalidation and reset', async () => {
    const site = await fixture(), other = await fixture();
    const endpoint = `/api/import-mappings?site_id=${site.id}`;
    const save = (family, aliases, identity) => api('/api/import-mappings', { method: 'PUT',
      cookie: auth.cookies.editor, body: { site_id: site.id, family, aliases, identity } });
    const defaults = await api(endpoint, { cookie: auth.cookies.owner });
    assert.equal(defaults.status, 200); assert.equal(defaults.body.length, 6);
    assert.ok(defaults.body.every(item => !item.custom));
    const initial = body(site, 'employees'), preview = await call('preview', initial);
    const saved = await save('employees', { employee_no: ['Worker'] }, ['employee_no']);
    assert.equal(saved.status, 200); assert.equal(saved.body.custom, true);
    const mismatch = await call('apply', { ...initial, preview_token: preview.body.preview_token });
    assert.equal(mismatch.status, 409); assert.equal(mismatch.body.code, 'PREVIEW_MISMATCH');
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM planning_import_runs WHERE site_id = ?', site.id)).n), 0);
    const aliasSample = { ...samples.employees, header: samples.employees.header.map(name => name === 'Employee No' ? 'Worker' : name) };
    const imported = await apply(site, 'employees', aliasSample);
    assert.equal(imported.result.counts.added, 1);
    const employee = await db.get('SELECT * FROM employees WHERE site_id = ?', site.id);
    const createdBinding = await db.get('SELECT * FROM planning_import_keys WHERE site_id = ?', site.id);
    const repeat = await apply(site, 'employees', aliasSample);
    assert.equal(repeat.result.counts.unchanged, 1);
    assert.deepEqual((await db.get('SELECT created_at FROM planning_import_keys WHERE site_id = ?', site.id)).created_at, createdBinding.created_at);
    assert.equal((await save('employees', { employee_no: ['Worker'] }, ['first_name', 'employee_no'])).status, 200);
    const changedIdentity = await apply(site, 'employees', aliasSample);
    assert.equal(changedIdentity.result.counts.unchanged, 1);
    assert.equal(changedIdentity.preview.samples.unchanged[0].key, '["Synthetic","E-1"]');
    assert.equal((await db.get('SELECT id FROM employees WHERE site_id = ?', site.id)).id, employee.id);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM planning_import_keys WHERE site_id = ?', site.id)).n), 1);
    const otherMappings = await api(`/api/import-mappings?site_id=${other.id}`, { cookie: auth.cookies.editor });
    assert.ok(otherMappings.body.every(item => !item.custom));
    const customPreview = await call('preview', body(site, 'employees', aliasSample));
    const reset = await api(`/api/import-mappings/employees?site_id=${site.id}`, { method: 'DELETE', cookie: auth.cookies.owner });
    assert.equal(reset.status, 200); assert.equal(reset.body.custom, false);
    assert.deepEqual(reset.body.identity, ['employee_no']); assert.deepEqual(reset.body.aliases, {});
    assert.equal((await call('apply', { ...body(site, 'employees', aliasSample), preview_token: customPreview.body.preview_token })).body.code, 'PREVIEW_MISMATCH');
    const restored = await apply(site, 'employees');
    assert.equal(restored.result.counts.unchanged, 1);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM employees WHERE site_id = ?', site.id)).n), 1);
    for (let i = 0; i < 2; i++) await db.transaction(tx => applyMigration(tx, '020_import_mappings.sql', { driver }));
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM planning_import_runs WHERE site_id = ?', site.id)).n), 4);
  });

  await t.test('WBS custom identity preserves hierarchy and existing ids', async () => {
    const site = await fixture();
    await apply(site, 'time_schedule');
    const before = await db.all('SELECT id FROM project_structure WHERE site_id = ? ORDER BY id', site.id);
    const saved = await api('/api/import-mappings', { method: 'PUT', cookie: auth.cookies.owner,
      body: { site_id: site.id, family: 'time_schedule', aliases: {}, identity: ['description'] } });
    assert.equal(saved.status, 200);
    const result = await apply(site, 'time_schedule');
    assert.equal(result.result.counts.unchanged, 3);
    assert.deepEqual(await db.all('SELECT id FROM project_structure WHERE site_id = ? ORDER BY id', site.id), before);
    const nodes = await db.all('SELECT * FROM project_structure WHERE site_id = ?', site.id);
    assert.equal(nodes.find(node => node.wbs_code === '1.1').parent_id, nodes.find(node => node.wbs_code === '1').id);
  });

  await t.test('progress custom identity preserves occurrences, ids and repeatability', async () => {
    const site = await fixture(); await apply(site, 'site_progress_items');
    const original = await db.all('SELECT id FROM site_progress_items WHERE site_id = ? ORDER BY id', site.id);
    for (const identity of [['description', 'progress_pct'], ['description']]) {
      const saved = await api('/api/import-mappings', { method: 'PUT', cookie: auth.cookies.owner,
        body: { site_id: site.id, family: 'site_progress_items', aliases: {}, identity } });
      assert.equal(saved.status, 200);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await apply(site, 'site_progress_items');
        assert.equal(result.result.counts.unchanged, 2);
        assert.equal(result.result.counts.added, 0);
        assert.deepEqual(await db.all('SELECT id FROM site_progress_items WHERE site_id = ? ORDER BY id', site.id), original);
      }
      const keys = await db.all('SELECT identity_state FROM planning_import_keys WHERE site_id = ?', site.id);
      assert.equal(keys.filter(row => row.identity_state === 'unresolved').length, identity.length === 1 ? 1 : 0);
    }
  });

  await t.test('mapping change immediately before the apply transaction rejects the token without writes', async () => {
    const site = await fixture(), input = body(site, 'employees');
    const preview = await call('preview', input);
    const racing = { get: (...args) => db.get(...args), all: (...args) => db.all(...args),
      transaction: async fn => {
        await saveImportMapping(db, { site_id: site.id, family: 'employees', aliases: { first_name: ['Given name'] }, identity: ['employee_no'] }, auth.users.owner);
        return db.transaction(fn);
      } };
    await assert.rejects(importRequest(racing, { ...input, preview_token: preview.body.preview_token }, auth.users.owner, { apply: true }), errorCode('PREVIEW_MISMATCH'));
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM employees WHERE site_id = ?', site.id)).n), 0);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM planning_import_runs WHERE site_id = ?', site.id)).n), 0);
  });

  await t.test('custom identity conflicts with fixed target uniqueness require reconciliation in preview', async () => {
    const site = await fixture(); await apply(site, 'employees');
    const save = await api('/api/import-mappings', { method: 'PUT', cookie: auth.cookies.owner,
      body: { site_id: site.id, family: 'employees', aliases: {}, identity: ['first_name'] } });
    assert.equal(save.status, 200);
    const conflicting = structuredClone(samples.employees); conflicting.rows[0][1] = 'Another synthetic name';
    const rejected = await apply(site, 'employees', conflicting);
    assert.equal(rejected.preview.samples.rejected[0].rejected, 'AMBIGUOUS_KEY');
    assert.equal(rejected.result.counts.rejected, 1); assert.equal(rejected.result.counts.added, 0);
    assert.equal((await db.get('SELECT first_name FROM employees WHERE site_id = ?', site.id)).first_name, 'Synthetic');
    const empty = await fixture();
    await api('/api/import-mappings', { method: 'PUT', cookie: auth.cookies.owner,
      body: { site_id: empty.id, family: 'employees', aliases: {}, identity: ['first_name'] } });
    const duplicates = await apply(empty, 'employees', { header: ['Employee No', 'First Name'], rows: [['E-1', 'Synthetic A'], ['E-1', 'Synthetic B']] });
    assert.equal(duplicates.result.counts.added, 1); assert.equal(duplicates.result.counts.rejected, 1);
  });

  await t.test('rejected rows retain their reasons; unknown employees are site-scoped', async () => {
    const site = await fixture(), other = await fixture();
    await apply(other, 'employees');
    const work = await apply(site, 'work_days');
    assert.equal(work.preview.counts.rejected, 1); assert.equal(work.preview.samples.rejected[0].rejected, 'EMPLOYEE_UNKNOWN');
    assert.equal(work.result.counts.added, 0);
    const result = await apply(site, 'deviations', { header: ['Deviation No', 'Deviation Status'], rows: [['D-1', '02 Pending'], ['D-2', '01 Open']] });
    assert.equal(result.result.counts.added, 1); assert.equal(result.result.counts.rejected, 1);
    assert.equal(result.preview.samples.rejected[0].rejected, 'UNKNOWN_STATUS');
    const diary = await apply(site, 'daily_log', { header: ['Date'], rows: [['2026-01-15'], ['2026-01-15']] });
    assert.equal(diary.result.counts.added, 1); assert.equal(diary.preview.samples.rejected[0].rejected, 'DUPLICATE_DAY');
  });

  await t.test('token mismatch, expiry, access checks and readonly preview', async () => {
    const site = await fixture(), other = await fixture(), input = body(site, 'employees');
    const p = await call('preview', input);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM planning_import_runs WHERE site_id = ?', site.id)).n), 0);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM planning_import_keys WHERE site_id = ?', site.id)).n), 0);
    for (const role of ['viewer', 'verifier']) for (const action of ['preview', 'apply']) {
      assert.equal((await call(action, { ...input, preview_token: p.body.preview_token }, role)).status, 403);
    }
    for (const alteration of [{ data_base64: Buffer.from('broken changed workbook').toString('base64') }, { site_id: other.id }, { family: 'deviations' }, { preview_token: 'forged' }]) {
      const result = await call('apply', { ...input, preview_token: p.body.preview_token, ...alteration });
      assert.equal(result.body.code, 'PREVIEW_MISMATCH');
    }
    const expired = previewToken({ buffer: Buffer.from(input.data_base64, 'base64'), family: 'employees', siteId: site.id, ...parsed('employees') }, { now: Date.now() - 900001 });
    assert.equal((await call('apply', { ...input, preview_token: expired })).body.code, 'PREVIEW_EXPIRED');
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM employees WHERE site_id = ?', site.id)).n), 0);
    const unrelated = await createSite(db, { code: randomUUID(), name: 'Synthetic unrelated site' });
    assert.equal((await call('preview', { ...input, site_id: unrelated.id })).status, 403);
    assert.equal((await call('preview', { ...input, family: 'unknown' })).body.code, 'UNKNOWN_FAMILY');
    assert.equal((await call('preview', { ...input, data_base64: '' })).body.code, 'EMPTY_FILE');
  });

  await t.test('preserve existing employee id, relationships, optional fields and other site', async () => {
    const site = await fixture(), other = await fixture();
    await apply(site, 'employees'); await apply(site, 'work_days'); await apply(other, 'employees');
    const employee = await db.get('SELECT * FROM employees WHERE site_id = ?', site.id);
    const otherBefore = await db.all('SELECT * FROM employees WHERE site_id = ?', other.id);
    await apply(site, 'employees', { header: ['Employee No', 'First Name'], rows: [['E-1', 'Revised synthetic']] });
    const after = await db.get('SELECT * FROM employees WHERE site_id = ?', site.id);
    assert.equal(after.id, employee.id); assert.equal(after.last_name, employee.last_name);
    assert.equal((await db.get('SELECT employee_id FROM work_days WHERE site_id = ?', site.id)).employee_id, employee.id);
    assert.deepEqual(await db.all('SELECT * FROM employees WHERE site_id = ?', other.id), otherBefore);
  });

  await t.test('samples are capped; database changes after preview are recomputed at apply', async () => {
    const site = await fixture(), sample = { header: ['Employee No', 'First Name'], rows: Array.from({ length: 61 }, (_, i) => [`S-${i}`, 'Synthetic']) };
    const input = body(site, 'employees', sample), p = await call('preview', input);
    assert.equal(p.body.counts.added, 61); assert.equal(p.body.samples.added.length, 50);
    await apply(site, 'employees', { ...sample, rows: sample.rows.slice(0, 1) });
    const result = await call('apply', { ...input, preview_token: p.body.preview_token });
    assert.equal(result.status, 200); assert.equal(result.body.counts.added, 60); assert.equal(result.body.counts.unchanged, 1);
    const removed = await diffFamily(db, { siteId: site.id, family: 'employees', rows: [] });
    assert.equal(removed.removed.count, 61); assert.equal(removed.removed.samples.length, 50);
  });

  await t.test('preexisting natural keys are adopted without replacing ids; ambiguous keys need reconciliation', async () => {
    const site = await fixture(), employeeId = randomUUID(), wbsIds = [randomUUID(), randomUUID()];
    const at = '2026-01-01T00:00:00.000Z';
    await db.run('INSERT INTO employees (id, site_id, employee_no, first_name, created_at) VALUES (?, ?, ?, ?, ?)',
      employeeId, site.id, 'E-1', 'Existing synthetic', at);
    const adopted = await apply(site, 'employees');
    assert.equal(adopted.result.counts.updated, 1); assert.equal(adopted.result.counts.added, 0);
    assert.equal((await db.get('SELECT id FROM employees WHERE site_id = ?', site.id)).id, employeeId);
    for (const id of wbsIds) await db.run('INSERT INTO project_structure (id, site_id, wbs_code, level, created_at) VALUES (?, ?, ?, ?, ?)', id, site.id, '1', 0, at);
    const ambiguous = await apply(site, 'time_schedule');
    assert.equal(ambiguous.result.counts.rejected, 2); // parent and its child
    assert.equal(ambiguous.result.counts.added, 1); // independent orphan root
    assert.equal(ambiguous.preview.samples.rejected[0].rejected, 'AMBIGUOUS_KEY');
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM project_structure WHERE site_id = ?', site.id)).n), 3);
  });

  await t.test('composite identity survives reordering, preserves microseconds and never reuses source rows', async () => {
    const site = await fixture(), sample = structuredClone(samples.site_progress_items);
    sample.rows[0][1] = '2026-01-15 08:30:00.123456';
    sample.rows[1] = [...sample.rows[0]];
    await apply(site, 'site_progress_items', sample);
    const original = await db.all('SELECT id, source_row FROM site_progress_items WHERE site_id = ? ORDER BY source_row', site.id);
    const extra = [...sample.rows[0]]; extra[0] = 'Another synthetic item';
    const reordered = { ...sample, rows: [extra, ...sample.rows] };
    const result = await apply(site, 'site_progress_items', reordered);
    assert.equal(result.result.counts.added, 1); assert.equal(result.result.counts.unchanged, 2);
    assert.equal(result.result.counts.updated, 0);
    const after = await db.all('SELECT id, source_row FROM site_progress_items WHERE site_id = ? ORDER BY source_row', site.id);
    assert.deepEqual(after.slice(0, 2), original); assert.equal(Number(after[2].source_row), 3);
    const smaller = await apply(site, 'site_progress_items', { ...sample, rows: [extra] });
    assert.equal(smaller.preview.counts.removed, 2); assert.equal(smaller.result.counts.removed, 0);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM site_progress_items WHERE site_id = ?', site.id)).n), 3);
  });

  await t.test('migration replay preserves application import history and keys', async () => {
    const site = await fixture(); await apply(site, 'employees');
    const before = await db.all('SELECT * FROM planning_import_keys WHERE site_id = ?', site.id);
    for (let attempt = 0; attempt < 2; attempt++) await db.transaction(tx => applyMigration(tx, '015_planning_import.sql', { driver }));
    assert.deepEqual(await db.all('SELECT * FROM planning_import_keys WHERE site_id = ?', site.id), before);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM planning_import_runs WHERE site_id = ?', site.id)).n), 1);
  });

  await t.test('whole transaction rolls back if a write fails', async () => {
    const site = await fixture(), normalized = parsed('employees');
    const failing = { transaction: fn => db.transaction(tx => fn({ ...tx, run: async (sql, ...args) => {
      if (sql.startsWith('INSERT INTO planning_import_keys')) throw new Error('Synthetic write failure');
      return tx.run(sql, ...args);
    } })) };
    await assert.rejects(applyFamily(failing, { siteId: site.id, family: 'employees', ...normalized, user: auth.users.owner }), /Synthetic write failure/);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM employees WHERE site_id = ?', site.id)).n), 0);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM planning_import_runs WHERE site_id = ?', site.id)).n), 0);
  });
});

test('planning HTTP socket: preview and apply over a listening server', async t => {
  const database = await openTestDb(); t.after(database.close);
  const site = await createSite(database.db, { code: randomUUID(), name: 'Synthetic HTTP site' });
  const auth = await authFixture(database.db, site), server = createServer(database.db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const f = samples.employees, input = { site_id: site.id, family: 'employees', filename: 'synthetic.xlsx', data_base64: xlsx(f.header, f.rows).toString('base64') };
  const request = (action, data) => fetch(`http://127.0.0.1:${server.address().port}/api/import/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: auth.cookies.owner }, body: JSON.stringify(data) });
  const p = await request('preview', input); assert.equal(p.status, 200);
  const preview = await p.json();
  const result = await request('apply', { ...input, preview_token: preview.preview_token });
  assert.equal(result.status, 200); assert.equal((await result.json()).counts.added, 1);
});
