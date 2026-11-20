import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { createApi } from '../app/api.mjs';
import { messages } from '../app/i18n.mjs';
import * as domain from '../app/domain.mjs';

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
function fragment(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}
const inspectionId = 'synthetic-inspection';
const photo = (extra = {}) => ({ id: 'synthetic-photo', entity_type: 'hse_inspection', entity_id: inspectionId,
  filename: 'Synthetic <condition> & "detail".png', mime: 'image/png', ...extra });
const image = () => new File(['synthetic image'], 'condition.png', { type: 'image/png' });

function ui({ role = 'editor', language = 'it', files = [], entityType = 'hse_inspection' } = {}) {
  const dialogs = [], notifications = [], requests = [], listeners = {}, missingKeys = [];
  let form, currentRole = role;
  const api = createApi({ baseUrl: 'https://api.example.invalid', fresh: true, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return Response.json(photo({ ...JSON.parse(options.body), id: 'synthetic-saved' }), { status: 201 });
  } });
  function makeForm(html) {
    const warning = { hidden: true }, error = { hidden: true, textContent: '', focus() {} }, submit = { disabled: false };
    const file = { files: [], addEventListener(type, callback) { this[type] = callback; } };
    const description = { value: '', addEventListener(type, callback) { this[type] = callback; } };
    return { id: 'attachment-form', dataset: {
      entityType: /data-entity-type="([^"]+)"/.exec(html)[1], entityId: /data-entity-id="([^"]+)"/.exec(html)[1],
    }, elements: { file, description }, isConnected: true, warning, error, submit,
    querySelector(selector) { return ({ '.form-error': error, '[type=submit]': submit, '[data-hse-attachment-warning]': warning })[selector]; }, querySelectorAll() { return []; } };
  }
  const row = { id: inspectionId, performedOn: '2026-11-15', performedBy: 'Synthetic inspector', mode: 'internal', outcome: 'pass', items: [] };
  const context = createContext({
    ...domain, messages, language, api, state: { attachments: files }, siteId: 'synthetic-site', reportDate: '2026-11-15',
    session: { user: { id: 'synthetic-user' } }, modalVersion: 0, offlineScope: 'synthetic-scope', storageReady: false, offline: false, errorMessage: error => messages[language][error.message] || error.message,
    navigator: { onLine: true }, permissions: () => domain.corePermissions(currentRole),
    t(key) { if (!Object.hasOwn(messages[language], key)) missingKeys.push(key); return messages[language][key] ?? key; },
    $: selector => selector === '#attachment-form' ? form : null,
    coreData: () => [{ id: 'synthetic-subject', name: 'Synthetic subject', templateCode: 'synthetic-family', status: 'ok' }],
    coreValue: value => String(value ?? '—'),
    coreResource: name => ({ data: name === 'hseInspectionTemplates' ? { templates: [] } : name.startsWith('hseInspectionHistory:') ? [row] : row }),
    showModal(title, html) { context.modalVersion++; dialogs.push({ title, html }); if (html.includes('id="attachment-form"')) form = makeForm(html); },
    closeModal() { context.modalVersion++; if (form) form.isConnected = false; },
    toast: message => notifications.push(message),
    document: { addEventListener(type, callback) { listeners[type] = callback; } },
    FormData: class { constructor(target) { return [['file', target.elements.file.files[0]], ['description', target.elements.description.value]]; } },
  });
  // Exercise the production renderers, delegated handlers, write path and API encoder with synthetic DOM controls.
  for (const [, name] of source.matchAll(/(?:async )?function (\w+)\(/g)) if (!(name in context)) context[name] = () => {};
  for (const [start, end] of [
    ['const esc =', 'let session ='], ['const dateLabel =', 'const timeLabel ='],
    ['const paths =', 'const badge ='], ['const button =', 'function toast('],
    ['const errorKeys =', 'function clearSession('], ['async function writeOperation(', 'const syncBadge ='],
    ['const syncBadge =', 'function renderOffline('],
    ['function renderHseViewToggle()', 'function renderHseAssets()'],
    ['function dateInput(', 'const formActions ='],
    ['const formActions =', 'function showPasswordForm('],
    ['function attachmentUrl(', 'function download('],
    ["document.addEventListener('click',", "document.addEventListener('submit',"],
    ["document.addEventListener('submit',", "$('#modal').addEventListener('cancel'"],
  ]) runInContext(fragment(start, end), context);
  const run = script => runInContext(script, context);
  run("hseAssetDetail.id = 'synthetic-subject'; hseAssetDetail.expanded.add('synthetic-inspection')");
  return {
    run, context, dialogs, notifications, requests, missingKeys,
    get form() { return form; }, get html() { return dialogs.at(-1)?.html ?? ''; },
    detail: () => run('renderHseAssetDetail()'),
    open: () => listeners.click({ target: { closest: () => ({ dataset: { command: 'new-attachment', entityType, id: inspectionId } }) } }),
    setRole(value) { currentRole = value; },
    choose(file) { form.elements.file.files = [file]; form.elements.file.change?.(); },
    save: () => listeners.submit({ target: form, preventDefault() {} }),
  };
}

test('inspection upload control is restricted to owner/editor and guarded on open and submit', async () => {
  for (const role of ['owner', 'editor', 'verifier', 'viewer', 'unassigned']) {
    const screen = ui({ role });
    assert.equal(screen.detail().includes('data-command="new-attachment"'), ['owner', 'editor'].includes(role));
    screen.open();
    assert.equal(screen.dialogs.length, ['owner', 'editor'].includes(role) ? 1 : 0);
  }
  const screen = ui(); screen.open(); screen.choose(image()); screen.setRole('viewer'); await screen.save();
  assert.equal(screen.requests.length, 0);
  assert.equal(screen.form.error.textContent, messages.it.forbidden);
});

test('expanded inspection and upload reuse the exact HSE privacy rule in IT/EN without fallback keys', () => {
  for (const language of ['it', 'en']) {
    const screen = ui({ language });
    const detail = screen.detail();
    assert.ok(detail.includes(messages[language].hseAttachmentRule));
    assert.ok(detail.includes(messages[language].addPhoto));
    screen.open();
    assert.ok(screen.html.includes(messages[language].hseAttachmentRule));
    assert.ok(screen.html.includes(messages[language].hseAttachmentAlternative));
    assert.match(screen.html, /accept="image\/\*,application\/pdf"/);
    assert.deepEqual(screen.missingKeys, []);
    screen.run("hseAssetDetail.expanded.clear()");
    assert.ok(!screen.detail().includes('attachment-section'));
  }
  assert.deepEqual(Object.keys(messages.it).sort(), Object.keys(messages.en).sort());
});

test('viewer sees only matching inspection photos as escaped, labelled thumbnails that open full images', async () => {
  const screen = ui({ role: 'viewer', files: [photo(), photo({ id: 'other-file', entity_id: 'other-inspection', filename: 'Other inspection.png' }), photo({ id: 'event-file', entity_type: 'hse_event', filename: 'Event.png' })] });
  const html = screen.detail();
  assert.match(html, /<button[^>]*data-command="open-attachment"[^>]*data-id="synthetic-photo"><img class="attachment-thumbnail"/);
  assert.match(html, /width="72" height="72"/);
  assert.ok(html.includes('Synthetic &lt;condition&gt; &amp; &quot;detail&quot;.png'));
  assert.ok(!html.includes(photo().filename));
  assert.ok(!html.includes('Other inspection.png'));
  assert.ok(!html.includes('Event.png'));
  assert.ok(!html.includes('data-command="new-attachment"'));
  assert.ok(html.includes('src="https://api.example.invalid/api/attachments/synthetic-photo"'));
  await screen.run("openAttachment('synthetic-photo')");
  assert.match(screen.html, /class="attachment-full-image" src="https:\/\/api.example.invalid\/api\/attachments\/synthetic-photo"/);
  assert.ok(screen.html.includes('alt="Synthetic &lt;condition&gt; &amp; &quot;detail&quot;.png"'));
});

test('inspection upload uses the existing API encoder with the inspection id and base64 payload for images and PDF', async () => {
  for (const file of [image(), new File(['%PDF-synthetic'], 'diagram.pdf', { type: 'application/pdf' })]) {
    const screen = ui(); screen.open(); screen.choose(file); await screen.save();
    assert.equal(screen.requests.length, 1);
    const { url, options } = screen.requests[0];
    assert.equal(url, 'https://api.example.invalid/api/attachments');
    assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'include');
    assert.deepEqual(JSON.parse(options.body), { site_id: 'synthetic-site', entity_type: 'hse_inspection', entity_id: inspectionId,
      filename: file.name, content_type: file.type, data_base64: Buffer.from(await file.arrayBuffer()).toString('base64') });
    assert.equal(screen.context.state.attachments.length, 1);
    assert.deepEqual(screen.notifications, [messages.it.attachmentSaved]);
  }
});

test('wrong type, empty and oversized files are refused before any request with the same HSE message in both languages', async () => {
  for (const language of ['it', 'en']) for (const entityType of ['hse_event', 'hse_inspection']) {
    for (const file of [
      { name: 'large.png', type: 'image/png', size: 15 * 1024 * 1024 + 1 },
      { name: 'file.txt', type: 'text/plain', size: 1 },
      { name: 'empty.png', type: 'image/png', size: 0 },
    ]) {
      const screen = ui({ language, entityType }); screen.open(); screen.choose(file); await screen.save();
      assert.equal(screen.requests.length, 0);
      assert.equal(screen.form.error.hidden, false);
      assert.equal(screen.form.error.textContent, messages[language].attachmentInvalid);
      assert.equal(screen.form.submit.disabled, false);
    }
  }
});

test('person or injury filename warning remains advisory and reacts to filename and description', async () => {
  for (const language of ['it', 'en']) {
    const screen = ui({ language }); screen.open();
    assert.equal(screen.form.warning.hidden, true);
    assert.ok(screen.html.includes(messages[language].hseAttachmentWarning));
    screen.choose(new File(['synthetic image'], 'injury.png', { type: 'image/png' }));
    assert.equal(screen.form.warning.hidden, false);
    await screen.save(); assert.equal(screen.requests.length, 1);
    const other = ui({ language }); other.open(); other.choose(image());
    assert.equal(other.form.warning.hidden, true);
    other.form.elements.description.value = 'injury'; other.form.elements.description.input();
    assert.equal(other.form.warning.hidden, false);
    other.form.elements.description.value = ''; other.form.elements.description.input();
    assert.equal(other.form.warning.hidden, true);
  }
});

test('service worker uses v15-26 and photo sizing stays bounded', async () => {
  const [sw, css] = await Promise.all(['sw.js', 'styles.css'].map(name => readFile(new URL(`../app/${name}`, import.meta.url), 'utf8')));
  const swVersion = Number(/siteassistant-v15-(\d+)/.exec(sw)?.[1]);
  assert.ok(swVersion >= 26, `cache version ${swVersion} must follow the current build`);
  assert.match(css, /\.attachment-thumbnail\s*\{[^}]*width: 72px;[^}]*height: 72px;[^}]*object-fit: cover;/);
  assert.match(css, /\.attachment-full-image\s*\{[^}]*max-width: 100%;/);
});
