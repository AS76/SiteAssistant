import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { canonicalHeaders, FAMILIES, parseFamily } from '../server/planning-import.mjs';
import { readWorkbook } from '../server/xlsx.mjs';
import { createServer } from '../server/http.mjs';
import { createApi } from '../app/api.mjs';
import { messages } from '../app/i18n.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { openTestDb } from './helpers/db.mjs';

const families = Object.keys(FAMILIES);
const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const filename = family => `SiteAssistant-${family}-modello.xlsx`;

function checkWorkbook(buffer, family) {
  const { header, rows } = readWorkbook(buffer);
  assert.deepEqual(header, canonicalHeaders(family));
  const fields = header.map(name => FAMILIES[family].columns[name].field);
  assert.equal(new Set(fields).size, header.length);
  assert.deepEqual(fields, [...new Set(Object.values(FAMILIES[family].columns).map(column => column.field))]);
  for (const name of header) assert.equal(name, Object.keys(FAMILIES[family].columns).find(key => FAMILIES[family].columns[key].field === FAMILIES[family].columns[name].field));
  assert.equal(rows.length, 1); assert.equal(rows[0].length, header.length);
  const parsed = parseFamily(buffer, family);
  assert.equal(parsed.rejected.length, 0); assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.unmapped_columns, []);
}

test('import template: canonical headers choose first aliases and reject unknown families', () => {
  assert.ok(canonicalHeaders('site_progress_items').includes('Planned Hours'));
  assert.ok(!canonicalHeaders('site_progress_items').includes('Planned Hours Total'));
  assert.ok(canonicalHeaders('deviations').includes('Deviation Status'));
  assert.ok(!canonicalHeaders('deviations').includes('Status'));
  assert.deepEqual(canonicalHeaders('daily_log'), ['Date', 'Activities', 'Delays', 'Plan', 'Next Step']);
  assert.throws(() => canonicalHeaders('unknown'), { code: 'UNKNOWN_FAMILY', status: 400 });
});

test('import template endpoint listener: six families, auth only, binary headers and errors', async t => {
  const { db, close } = await openTestDb(); t.after(close);
  const auth = await authFixture(db); // No memberships: templates have no site scope.
  const server = createServer(db), request = requestListener(server);
  for (const family of families) await t.test(family, async () => {
    const response = await request(`/api/import/template?family=${family}`, { cookie: auth.cookies.owner });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], mime);
    assert.equal(response.headers['content-disposition'], `attachment; filename="${filename(family)}"`);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    checkWorkbook(response.body, family);
  });
  for (const role of ['editor', 'viewer', 'verifier']) {
    assert.equal((await request('/api/import/template?family=employees', { cookie: auth.cookies[role] })).status, 200);
  }
  for (const query of ['', '?family=unknown', '?family=__proto__', '?family=constructor']) {
    const response = await request(`/api/import/template${query}`, { cookie: auth.cookies.owner });
    assert.equal(response.status, 400); assert.equal(response.body.code, 'UNKNOWN_FAMILY');
  }
  for (const query of ['?family=employees', '?family=unknown']) {
    const response = await request(`/api/import/template${query}`);
    assert.equal(response.status, 401); assert.equal(response.body.code, 'AUTH_REQUIRED');
  }
});

test('import template real HTTP: six downloadable workbooks', async t => {
  const { db, close } = await openTestDb(); t.after(close);
  const auth = await authFixture(db), server = createServer(db);
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const family of families) {
    const response = await fetch(`${base}/api/import/template?family=${family}`, { headers: { cookie: auth.cookies.owner } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), mime);
    checkWorkbook(Buffer.from(await response.arrayBuffer()), family);
  }
});

test('import template client: family URL, credentials, Blob and download filename', async () => {
  const calls = [], blob = new Blob(['synthetic'], { type: mime });
  const api = createApi({ baseUrl: 'https://api.example.invalid/', fetchImpl: async (...args) => {
    calls.push(args); return { ok: true, status: 200, blob: async () => blob };
  } });
  for (const family of families) {
    assert.deepEqual(await api.importTemplate(family), { blob, filename: filename(family) });
    assert.equal(calls.at(-1)[0], `https://api.example.invalid/api/import/template?family=${family}`);
    assert.equal(calls.at(-1)[1].credentials, 'include');
  }
  await api.importTemplate('synthetic & family');
  assert.equal(calls.at(-1)[0], 'https://api.example.invalid/api/import/template?family=synthetic+%26+family');
  let unauthorized = 0;
  const denied = createApi({ onUnauthorized: () => unauthorized++, fetchImpl: async () => ({ ok: false, status: 401,
    json: async () => ({ code: 'AUTH_REQUIRED', error: 'A valid session is required.' }) }) });
  await assert.rejects(denied.importTemplate('employees'), { status: 401, code: 'AUTH_REQUIRED' });
  assert.equal(unauthorized, 1);
  const invalid = createApi({ fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ code: 'UNKNOWN_FAMILY' }) }) });
  await assert.rejects(invalid.importTemplate('unknown'), { status: 400, code: 'UNKNOWN_FAMILY' });
  const disconnected = createApi({ fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(disconnected.importTemplate('employees'), { code: 'NETWORK_ERROR' });
});

test('import template UI: role gate, selected family download, shared download helper and translations', async () => {
  const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
  const downloads = [], errors = [], requested = [], blob = new Blob(['synthetic'], { type: mime });
  const form = { elements: { family: { value: 'daily_log' } }, isConnected: true };
  const target = { disabled: false, closest: () => form };
  const context = createContext({ role: () => 'viewer', modalVersion: 0, siteId: 'synthetic-site', target,
    showModal: () => { throw new Error('Viewer must not open import dialog'); },
    api: { importTemplate: async family => { requested.push(family); return { blob, filename: filename(family) }; } },
    download: (...args) => downloads.push(args), formError: (...args) => errors.push(args),
  });
  runInContext(source.slice(source.indexOf('let importPreview = null;'), source.indexOf('async function showCoreDetail')), context);
  await runInContext('showImportForm()', context);
  await runInContext('downloadImportTemplate(target)', context);
  assert.equal(requested.length, 0);
  for (const role of ['owner', 'editor']) {
    context.role = () => role;
    await runInContext('downloadImportTemplate(target)', context);
    assert.equal(requested.at(-1), 'daily_log');
    assert.deepEqual(downloads.at(-1), [blob, mime, filename('daily_log')]);
  }
  context.api.importTemplate = async () => { throw new Error('offline'); };
  await runInContext('downloadImportTemplate(target)', context);
  assert.equal(errors.length, 1); assert.equal(target.disabled, false);
  assert.match(source, /'import-template-download': \(\) => downloadImportTemplate\(target\)/);
  assert.match(source, /button\('importTemplateDownload', 'import-template-download'\)/);
  for (const lang of ['it', 'en']) for (const key of ['importTemplateDownload', 'importTemplateHint']) assert.ok(messages[lang][key]);
  const sw = await readFile(new URL('../app/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /siteassistant-v15-12/);
});
