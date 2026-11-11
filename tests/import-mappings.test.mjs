import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { resolveMapping, DEFAULT_IDENTITIES, FAMILIES, previewToken, verifyPreviewToken } from '../server/planning-import.mjs';
import { createApi } from '../app/api.mjs';
import { messages } from '../app/i18n.mjs';
import { createServer } from '../server/http.mjs';
import { createSite } from '../server/repository.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { openTestDb } from './helpers/db.mjs';
import { applyMigration } from '../server/migrations/index.mjs';

const row = (aliases, identity) => ({ aliases_json: JSON.stringify(aliases), identity_json: JSON.stringify(identity) });
const code = expected => error => error.code === expected && error.status === 400;

test('import mappings: defaults and destination normalizers stay fixed', () => {
  for (const family of Object.keys(FAMILIES)) {
    const mapping = resolveMapping(family, null);
    assert.deepEqual(mapping.columns, FAMILIES[family].columns);
    assert.deepEqual(mapping.required, FAMILIES[family].required);
    assert.deepEqual(mapping.identity, DEFAULT_IDENTITIES[family]);
    assert.deepEqual(mapping.aliases, {});
  }
  const mapping = resolveMapping('employees', row({ employee_no: ['Worker reference'] }, ['employee_no']));
  assert.equal(mapping.columns['Worker reference'].normalize, FAMILIES.employees.columns['Employee No'].normalize);
  assert.equal(mapping.columns['Worker reference'].field, 'employee_no');
  mapping.identity.push('first_name');
  assert.deepEqual(resolveMapping('employees').identity, ['employee_no']);
});

test('import mappings: reject invalid JSON shapes, fields, identities and duplicate aliases', () => {
  const invalid = [
    row([], ['employee_no']), row(null, ['employee_no']), row('text', ['employee_no']),
    row({}, {}), row({}, null), row({}, []), row({}, ['absent']), row({}, ['employee_no', 'employee_no']),
    row({}, [null]), row({}, [3]), row({ absent: ['Header'] }, ['employee_no']),
    row({ employee_no: 'Header' }, ['employee_no']), row({ employee_no: [null] }, ['employee_no']),
    row({ employee_no: [''] }, ['employee_no']), row({ employee_no: ['   '] }, ['employee_no']),
    row({ employee_no: ['x'.repeat(81)] }, ['employee_no']),
    row({ employee_no: ['Employee No'] }, ['employee_no']), row({ employee_no: ['First Name'] }, ['employee_no']),
    row({ employee_no: ['Header', 'Header'] }, ['employee_no']),
    row({ employee_no: ['Header', ' Header '] }, ['employee_no']),
    row({ employee_no: ['Header'], first_name: ['Header'] }, ['employee_no']),
    { aliases_json: '{broken', identity_json: '[]' }, { aliases_json: '{}', identity_json: '{broken' },
  ];
  for (const input of invalid) assert.throws(() => resolveMapping('employees', input), code('MAP_INVALID'));
  assert.throws(() => resolveMapping('unknown'), code('UNKNOWN_FAMILY'));
  const boundary = resolveMapping('employees', row({ employee_no: ['x'.repeat(80), '__proto__'] }, ['employee_no']));
  assert.equal(boundary.columns['x'.repeat(80)].field, 'employee_no');
  assert.equal(Object.getPrototypeOf(boundary.columns), Object.prototype);
  assert.equal(boundary.columns.__proto__.field, 'employee_no');
});

test('import mappings: preview digest includes unused aliases and identity order', () => {
  const input = { family: 'employees', siteId: randomUUID(), buffer: Buffer.from('Synthetic token fixture'), rows: [] };
  const token = previewToken(input);
  verifyPreviewToken(token, input);
  for (const mapping of [resolveMapping('employees', row({ first_name: ['Given name'] }, ['employee_no'])),
    resolveMapping('employees', row({}, ['first_name', 'employee_no']))]) {
    assert.throws(() => verifyPreviewToken(token, { ...input, mapping }), error => error.code === 'PREVIEW_MISMATCH');
  }
  const mapping = resolveMapping('employees', row({}, ['first_name', 'employee_no']));
  const ordered = previewToken({ ...input, mapping });
  assert.throws(() => verifyPreviewToken(ordered, { ...input,
    mapping: resolveMapping('employees', row({}, ['employee_no', 'first_name'])) }), error => error.code === 'PREVIEW_MISMATCH');
});

test('import mappings HTTP: roles, upsert, validation, site scope and default restoration', async t => {
  const database = await openTestDb(); t.after(database.close);
  const db = database.db, site = await createSite(db, { code: randomUUID(), name: 'Synthetic mapping site' });
  const other = await createSite(db, { code: randomUUID(), name: 'Synthetic isolated site' });
  const auth = await authFixture(db, site), api = requestListener(createServer(db));
  const endpoint = `/api/import-mappings?site_id=${site.id}`;
  const payload = { site_id: site.id, family: 'employees', aliases: { employee_no: ['Worker'] }, identity: ['employee_no'] };
  assert.equal((await api(endpoint)).status, 401);
  for (const role of ['viewer', 'verifier']) {
    const cookie = auth.cookies[role];
    assert.equal((await api(endpoint, { cookie })).status, 403);
    assert.equal((await api('/api/import-mappings', { method: 'PUT', cookie, body: payload })).status, 403);
    assert.equal((await api(`/api/import-mappings/employees?site_id=${site.id}`, { method: 'DELETE', cookie })).status, 403);
  }
  for (const role of ['owner', 'editor']) {
    const cookie = auth.cookies[role];
    const defaults = await api(endpoint, { cookie });
    assert.equal(defaults.status, 200); assert.equal(defaults.body.length, 6);
    assert.ok(defaults.body.every(mapping => mapping.custom === false));
    const saved = await api('/api/import-mappings', { method: 'PUT', cookie, body: payload });
    assert.equal(saved.status, 200); assert.equal(saved.body.custom, true);
    assert.deepEqual(saved.body.aliases, payload.aliases); assert.deepEqual(saved.body.identity, payload.identity);
    assert.ok(saved.body.fields.includes('first_name'));
    const before = await db.get('SELECT * FROM import_mappings WHERE site_id = ?', site.id);
    const updated = await api('/api/import-mappings', { method: 'PUT', cookie,
      body: { ...payload, aliases: { first_name: ['Given name'] }, identity: ['first_name', 'employee_no'] } });
    assert.equal(updated.status, 200);
    const after = await db.get('SELECT * FROM import_mappings WHERE site_id = ?', site.id);
    assert.equal(after.id, before.id); assert.deepEqual(after.created_at, before.created_at);
    assert.ok(Date.parse(after.updated_at) >= Date.parse(before.updated_at));
    const list = await api(endpoint, { cookie });
    assert.deepEqual(list.body.find(mapping => mapping.family === 'employees'), updated.body);
    const beforeInvalid = await db.all('SELECT * FROM import_mappings WHERE site_id = ?', site.id);
    for (const change of [{ aliases: [] }, { aliases: null }, { aliases: { absent: ['Header'] } },
      { aliases: { employee_no: ['Worker'], first_name: ['Worker'] } }, { aliases: { employee_no: ['First Name'] } },
      { identity: [] }, { identity: {} }, { identity: ['employee_no', 'employee_no'] }, { identity: ['absent'] }]) {
      const response = await api('/api/import-mappings', { method: 'PUT', cookie, body: { ...payload, ...change } });
      assert.equal(response.status, 400); assert.equal(response.body.code, 'MAP_INVALID');
    }
    assert.deepEqual(await db.all('SELECT * FROM import_mappings WHERE site_id = ?', site.id), beforeInvalid);
    const unknown = await api('/api/import-mappings', { method: 'PUT', cookie, body: { ...payload, family: 'unknown' } });
    assert.equal(unknown.status, 400); assert.equal(unknown.body.code, 'UNKNOWN_FAMILY');
    const unknownDelete = await api(`/api/import-mappings/unknown?site_id=${site.id}`, { method: 'DELETE', cookie });
    assert.equal(unknownDelete.body.code, 'UNKNOWN_FAMILY');
    assert.equal((await api(`/api/import-mappings?site_id=${other.id}`, { cookie })).status, 403);
    assert.equal((await api('/api/import-mappings', { method: 'PUT', cookie, body: { ...payload, site_id: other.id } })).status, 403);
    assert.equal((await api(`/api/import-mappings/employees?site_id=${other.id}`, { method: 'DELETE', cookie })).status, 403);
    assert.equal((await api('/api/import-mappings?site_id=invalid', { cookie })).status, 400);
    for (let attempt = 0; attempt < 2; attempt++) {
      const reset = await api(`/api/import-mappings/employees?site_id=${site.id}`, { method: 'DELETE', cookie });
      assert.equal(reset.status, 200); assert.equal(reset.body.custom, false);
      assert.deepEqual(reset.body.aliases, {}); assert.deepEqual(reset.body.identity, ['employee_no']);
    }
  }
});

test('import mappings schema: uniqueness, foreign key, defaults and additive replay', async t => {
  const database = await openTestDb(); t.after(database.close);
  const db = database.db, site = await createSite(db, { code: randomUUID(), name: 'Synthetic schema site' });
  const insert = (id, siteId, family) => db.run(`INSERT INTO import_mappings (id, site_id, family, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`, id, siteId, family, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  await insert(randomUUID(), site.id, 'employees');
  const before = await db.get('SELECT * FROM import_mappings WHERE site_id = ?', site.id);
  assert.equal(before.aliases_json, '{}'); assert.equal(before.identity_json, '[]');
  await assert.rejects(insert(randomUUID(), site.id, 'employees'));
  await assert.rejects(insert(randomUUID(), randomUUID(), 'employees'));
  const driver = process.env.DB_DRIVER === 'pg' ? 'pg' : 'sqlite';
  for (let attempt = 0; attempt < 2; attempt++) await db.transaction(tx => applyMigration(tx, '020_import_mappings.sql', { driver }));
  assert.deepEqual(await db.get('SELECT * FROM import_mappings WHERE site_id = ?', site.id), before);
});

test('import mappings client: fresh GET, PUT and DELETE encode the expected scope', async () => {
  const calls = [], baseUrl = 'https://api.example.invalid';
  const client = createApi({ baseUrl, fresh: true, fetchImpl: async (...args) => {
    calls.push(args); return { ok: true, status: 200, json: async () => ({}) };
  } });
  await client.listImportMappings('site synthetic');
  const input = { site_id: 'site synthetic', family: 'employees', aliases: {}, identity: ['employee_no'] };
  await client.saveImportMapping(input);
  await client.deleteImportMapping('site synthetic', 'employees');
  assert.equal(calls[0][0], `${baseUrl}/api/import-mappings?site_id=site+synthetic`);
  assert.equal(calls[0][1].cache, 'reload'); assert.equal(calls[0][1].credentials, 'include');
  assert.equal(calls[1][1].method, 'PUT'); assert.deepEqual(JSON.parse(calls[1][1].body), input);
  assert.equal(calls[2][0], `${baseUrl}/api/import-mappings/employees?site_id=site+synthetic`);
  assert.equal(calls[2][1].method, 'DELETE');
});

test('import mappings UI: new labels are translated in both languages', () => {
  for (const key of Object.keys(messages.it).filter(key => key.startsWith('importMapping') || ['importPreviewRequired', 'importPreviewCurrent', 'importPreviewStale'].includes(key))) {
    assert.equal(typeof messages.en[key], 'string'); assert.ok(messages.en[key].length);
  }
});

// Exercise the import dialog's state transitions without sockets or a browser dependency.
async function importUi() {
  const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
  const submit = {}, hint = {}, result = {}, fieldset = {}, fields = {}, order = {}, error = {};
  class SyntheticFile { constructor() { this.name = 'synthetic.xlsx'; this.size = 1; } }
  const alias = { value: '', dataset: { importAlias: 'employee_no' } };
  const controls = { family: { value: 'employees' }, file: { files: [new SyntheticFile()] } };
  const form = { dataset: {}, isConnected: true, elements: controls,
    querySelector: selector => ({ '[type=submit]': submit, 'button[type=submit]': submit,
      '#import-preview-hint': hint, '#import-result': result, '#import-mapping fieldset': fieldset,
      '#import-mapping-fields': fields, '#import-identity-order': order, '.form-error': error })[selector],
    querySelectorAll: () => [alias] };
  submit.dataset = {};
  const defaults = { family: 'employees', aliases: {}, identity: ['employee_no'], fields: ['employee_no', 'first_name'], custom: false };
  let saved = defaults, previews = 0, applies = 0;
  const context = createContext({
    api: {
      previewImport: async () => { previews++; return { preview_token: 'synthetic-token', counts: { added: 1 } }; },
      applyImport: async () => { applies++; return { counts: { added: 1 } }; },
      saveImportMapping: async input => (saved = { ...defaults, ...input, custom: true }),
      deleteImportMapping: async () => (saved = defaults),
    },
    freshApi: { listImportMappings: async () => [saved] },
    File: SyntheticFile,
    FileReader: class { readAsDataURL() { this.result = 'data:application/octet-stream;base64,QQ=='; this.onload(); } },
    FormData: class { constructor() { this.values = [['family', controls.family.value], ['file', controls.file.files[0]]]; }
      [Symbol.iterator]() { return this.values[Symbol.iterator](); } },
    siteId: 'synthetic-site', modalVersion: 0, role: () => 'owner', t: key => key, esc: String,
    button: () => '', $: () => form, showModal: () => {}, formError: () => {}, closeModal: () => {},
    coreCache: new Map(), overviewCache: new Map(), loadData: async () => {}, toast: () => {}, form,
  });
  runInContext(source.slice(source.indexOf('let importPreview = null;'), source.indexOf('async function showCoreDetail')), context);
  await runInContext('showImportForm()', context);
  return { context, form, submit, hint, alias, previews: () => previews, applies: () => applies };
}

test('import mapping UI flow: editing, saving and reset require a fresh preview before apply', async () => {
  const ui = await importUi(), run = script => runInContext(script, ui.context);
  assert.equal(ui.submit.disabled, false);
  await run('handleImport(form)');
  assert.equal(ui.submit.dataset.step, 'apply'); assert.equal(ui.applies(), 0);
  ui.alias.value = 'Worker';
  run('form.mappingDirty = true; invalidateImportPreview(form)');
  assert.equal(ui.submit.disabled, true); assert.equal(ui.hint.textContent, 'importMappingUnsaved');
  await assert.rejects(run('handleImport(form)'), /importMappingUnsaved/);
  await run('changeImportMapping()');
  assert.equal(ui.submit.textContent, 'importPreview'); assert.equal(ui.submit.disabled, false);
  await run('handleImport(form)');
  assert.equal(ui.applies(), 0); assert.equal(ui.previews(), 2);
  await run('changeImportMapping(true)');
  assert.equal(ui.submit.dataset.step, undefined); assert.equal(ui.submit.textContent, 'importPreview');
  await run('handleImport(form)'); await run('handleImport(form)');
  assert.equal(ui.previews(), 3); assert.equal(ui.applies(), 1);
});

test('import mapping UI flow: late previews are discarded and server mismatches clear the apply step', async () => {
  const ui = await importUi(), run = script => runInContext(script, ui.context);
  let started, finish;
  const requestStarted = new Promise(resolve => { started = resolve; });
  ui.context.api.previewImport = () => { started(); return new Promise(resolve => { finish = resolve; }); };
  const pending = run('handleImport(form)');
  await requestStarted;
  run('invalidateImportPreview(form)');
  finish({ preview_token: 'obsolete-token', counts: {} });
  await pending;
  assert.equal(ui.submit.dataset.step, undefined); assert.equal(run('importPreview'), null);
  ui.context.api.previewImport = async () => ({ preview_token: 'current-token', counts: {} });
  await run('handleImport(form)');
  ui.context.api.applyImport = async () => { throw Object.assign(new Error('Mapping changed'), { code: 'PREVIEW_MISMATCH' }); };
  await assert.rejects(run('handleImport(form)'), /Mapping changed/);
  assert.equal(run('importPreview'), null); assert.equal(ui.submit.dataset.step, undefined);
  assert.equal(ui.submit.textContent, 'importPreview');
});


test('import mapping UI: comma-separated aliases preserve literal commas and backslashes', async () => {
  const ui = await importUi();
  ui.context.aliasNames = ['Synthetic header, detail', 'Synthetic\\path', 'Plain header'];
  const result = runInContext('parseImportAliases(formatImportAliases(aliasNames))', ui.context);
  assert.deepEqual(Array.from(result), ui.context.aliasNames);
  assert.deepEqual(Array.from(runInContext("parseImportAliases('First, Second')", ui.context)), ['First', 'Second']);
});
