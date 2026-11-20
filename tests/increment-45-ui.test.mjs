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
const asset = () => ({ id: 'synthetic-subject', templateCode: 'synthetic-family', name: 'Synthetic subject', status: 'never' });
const family = () => ({ code: 'synthetic-family', title: 'Synthetic family', items: Array.from({ length: 10 }, (_, index) => ({ code: `check-${index}`, label: `Synthetic check ${index}` })) });
const plain = value => JSON.parse(JSON.stringify(value));
function node(value = '') {
  return { value, hidden: true, textContent: '', dataset: {}, attributes: {},
    focus() { this.focused = true; }, setCustomValidity() {}, removeAttribute(key) { delete this.attributes[key]; }, setAttribute(key, value) { this.attributes[key] = value; } };
}
function makeForm(html) {
  const elements = {}, listeners = {};
  for (const [, name, content] of html.matchAll(/<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    elements[name] = node(content.match(/<option value="([^"]*)"/)?.[1] ?? '');
  }
  for (const [, attrs, name] of html.matchAll(/<input\b([^>]*name="([^"]+)"[^>]*)>/g)) elements[name] = node(attrs.match(/value="([^"]*)"/)?.[1] ?? '');
  for (const [, name, content] of html.matchAll(/<textarea[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) elements[name] = node(content);
  for (const [name, control] of Object.entries(elements)) control.name = name;
  const progress = node(), missing = node(), external = node(), error = node(), submit = { disabled: true };
  const dateInput = Object.assign(elements.performedOn, { required: true, id: 'field-performedOn' });
  const dateError = node();
  const form = {
    id: 'hse-inspection-form', dataset: { site: html.match(/data-site="([^"]+)"/)[1] }, elements, isConnected: true,
    progress, missing, external, error, submit, rows: [],
    addEventListener(type, callback) { listeners[type] = callback; },
    dispatch(type, target) { listeners[type]?.({ target }); },
    querySelectorAll() { return [dateInput]; },
    querySelector(selector) { return ({ '#field-performedOn-error': dateError, '#hse-inspection-progress': progress, '#hse-inspection-missing': missing, '#hse-inspection-external': external, '.form-error': error, '[type=submit]': submit })[selector]; },
  };
  for (const [, index] of html.matchAll(/data-inspection-row="(\d+)"/g)) {
    const note = node(), textarea = { ...node(), dataset: { inspectionNote: index }, disabled: true };
    const row = { note, textarea, choices: [], querySelector(selector) { return selector === 'textarea' ? textarea : note; }, querySelectorAll() { return this.choices; } };
    row.choices = ['ok', 'not_ok', 'na'].map(result => ({ ...node(), dataset: { command: 'hse-inspection-result', index, result }, attributes: { 'aria-pressed': 'false' }, closest(selector) { return selector === '#hse-inspection-form' ? form : selector === '[data-inspection-row]' ? row : this; } }));
    form.rows.push(row);
  }
  return form;
}

function ui({ role = 'editor', language = 'it', templates = [family()], respond } = {}) {
  const main = { innerHTML: '', insertAdjacentHTML(_where, html) { this.innerHTML += html; }, setAttribute() {} };
  const dialogs = [], notifications = [], requests = [], listeners = {}, missingKeys = [];
  let form, history = [], savedAsset = asset(), closed = 0;
  const api = createApi({ baseUrl: 'https://api.example.invalid', fresh: true, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    const response = await respond?.(url, options);
    if (response) return response;
    if (options.method === 'POST') {
      const fields = JSON.parse(options.body);
      const saved = { ...fields, id: 'synthetic-inspection', next_due_on: '2027-05-15', items: fields.items.map(item => ({ ...item, label: `Stored ${item.code}` })) };
      history = [saved]; savedAsset = { ...asset(), status: 'ok', lastInspectionOn: fields.performedOn, nextDueOn: saved.next_due_on };
      return Response.json(saved);
    }
    if (url.includes('inspection-templates')) return Response.json({ templates });
    if (url.includes('/inspections?')) return Response.json(history);
    if (url.includes('/inspections/')) return Response.json({ ...history[0], asset: savedAsset });
    if (url.includes('/assets?')) return Response.json([savedAsset]);
    throw new Error('Unexpected synthetic request');
  } });
  const context = createContext({
    ...domain, messages, language, api, freshApi: api, modalVersion: 0,
    siteId: 'synthetic-site', session: { user: { id: 'synthetic-user', name: 'Synthetic inspector' } },
    view: 'hse', hseView: 'inspections', hseAssetFilters: { category: '', status: '' }, hseAssetOrder: 'due',
    coreFilters: { hse: {} }, moduleResources: { hse: ['hse', 'hseAssets'] },
    coreCache: new Map([['synthetic-site', new Map([['hseAssets', { data: [asset()] }]])]]),
    permissions: () => domain.corePermissions(role), offline: false, navigator: { onLine: true }, columnFiltersOn: false,
    t(key) { if (!Object.hasOwn(messages[language], key)) missingKeys.push(key); return messages[language][key] ?? key; },
    currentSite: () => ({ name: 'Synthetic site', code: 'SYN' }),
    $: selector => selector === '#main' ? main : selector === '#hse-inspection-form' ? form : form?.querySelector(selector),
    render: () => runInContext('renderCore()', context),
    document: { addEventListener(type, callback) { listeners[type] = callback; } },
    showModal(title, html) { context.modalVersion++; dialogs.push({ title, html }); if (html.includes('id="hse-inspection-form"')) form = makeForm(html); },
    closeModal() { context.modalVersion++; closed++; if (form) form.isConnected = false; },
    toast: message => notifications.push(message),
    FormData: class { constructor(target) { return Object.entries(target.elements).map(([name, control]) => [name, control.value]); } },
    renderAuditPanel: () => '', bindAuditPanel() {}, enhanceCoreTables() {}, rememberTodayResource() {},
  });
  // Run the production renderers and event handlers with synthetic DOM controls and fetch responses.
  for (const [, name] of source.matchAll(/(?:async )?function (\w+)\(/g)) if (!(name in context)) context[name] = () => {};
  for (const [start, end] of [
    ['const esc =', 'let session ='], ['const dateLabel =', 'const timeLabel ='], ['const paths =', 'const badge ='],
    ['const button =', 'function toast('], ['function heading(', 'function renderChrome('],
    ['function coreResource(', 'function progressBar('], ['function renderCore()', 'function auditEntityType()'],
    ['function renderHseViewToggle()', 'function renderHse()'], ['function field(', 'function showPasswordForm()'],
    ["document.addEventListener('click',", "document.addEventListener('submit',"],
    ["document.addEventListener('submit',", "$('#modal').addEventListener('cancel'"],
  ]) runInContext(fragment(start, end), context);
  const run = script => runInContext(script, context);
  const settle = async () => {
    for (let turn = 0; turn < 12; turn++) {
      const pending = [...context.coreCache.values()].flatMap(cache => [...cache.values()].filter(row => row.pending).map(row => row.promise));
      if (!pending.length) return;
      await Promise.all(pending);
    }
    assert.fail('Synthetic resource cache did not settle');
  };
  const click = (command, extra = {}) => listeners.click({ target: { closest: () => ({ dataset: { command, ...extra } }) } });
  const screen = {
    context, run, settle, dialogs, notifications, requests, missingKeys, main, click,
    get form() { return form; }, get closed() { return closed; }, get html() { return dialogs.at(-1)?.html ?? ''; },
    async detail() { run("openHseAssetDetail('synthetic-subject')"); await settle(); },
    async open() { await this.detail(); await run('showHseInspectionForm()'); },
    result(index, value) { const control = form.rows[index].choices.find(choice => choice.dataset.result === value); listeners.click({ target: control }); },
    field(name, value) { form.elements[name].value = value; form.dispatch('change', form.elements[name]); },
    note(index, value) { const input = form.rows[index].textarea; input.value = value; form.dispatch('input', input); },
    answerAll(value = 'ok') { for (let index = 0; index < form.rows.length; index++) this.result(index, value); },
    save() { return listeners.submit({ target: form, preventDefault() {} }); },
  };
  return screen;
}

await test('new inspection is a primary subject-detail action only for owner and editor', async () => {
  for (const role of ['owner', 'editor', 'verifier', 'viewer', undefined]) {
    const screen = ui({ role: role ?? 'unassigned' });
    await screen.detail();
    assert.equal(screen.main.innerHTML.includes('data-command="hse-inspection-new"'), ['owner', 'editor'].includes(role));
    if (['owner', 'editor'].includes(role)) assert.match(screen.main.innerHTML, /class="primary" data-command="hse-inspection-new"/);
    else { await screen.run('showHseInspectionForm()'); assert.equal(screen.dialogs.length, 0); }
  }
});

await test('form selects the matching family, renders every labelled three-way group and header defaults in both languages', async () => {
  for (const language of ['it', 'en']) {
    const screen = ui({ language, templates: [{ code: 'other-family', items: [{ code: 'other', label: 'Unrelated check' }] }, family()] });
    await screen.open();
    assert.equal(screen.form.elements.performedOn.value, domain.formatDateInput(domain.today(), language));
    assert.equal(screen.form.elements.performedBy.value, 'Synthetic inspector');
    assert.equal(screen.form.elements.mode.value, 'internal');
    assert.equal(screen.form.rows.length, 10);
    assert.equal((screen.html.match(/role="group" aria-labelledby="hse-check-label-/g) ?? []).length, 10);
    assert.equal((screen.html.match(/aria-pressed="false"/g) ?? []).length, 30);
    for (const item of family().items) assert.ok(screen.html.includes(item.label));
    assert.ok(!screen.html.includes('Unrelated check'));
    for (const result of ['ok', 'not_ok', 'na']) assert.equal(screen.html.split(`>${messages[language][domain.inspectionItemResultLabelKey(result)]}</button>`).length - 1, 10);
    assert.match(screen.html, /name="performedOn"[^>]*required/);
    assert.match(screen.html, /name="performedBy"[^>]*required[^>]*maxlength="200"/);
    assert.match(screen.html, /name="performerRole" maxlength="120" list=/);
    assert.match(screen.html, /name="notes"[^>]*maxlength="2000"/);
    assert.deepEqual(screen.missingKeys, []);
  }
});

await test('progress counts valid answers without mutating inputs and reports missing codes', () => {
  const items = Object.freeze([{ code: 'a', result: 'ok' }, { code: 'b' }, { code: 'c', result: 'na' }, { code: 'd', result: 'not_ok' }, { code: 'e', result: 'unknown' }].map(Object.freeze));
  assert.deepEqual(domain.inspectionProgress(items), { answered: 3, total: 5, missing: ['b', 'e'] });
  assert.deepEqual(domain.inspectionProgress(), { answered: 0, total: 0, missing: [] });
});

await test('save stays disabled until every check is answered; progress and missing count update', async () => {
  for (const language of ['it', 'en']) {
    const screen = ui({ language }); await screen.open();
    assert.equal(screen.form.submit.disabled, true);
    await screen.save(); assert.equal(screen.requests.filter(row => row.options.method === 'POST').length, 0);
    for (let index = 0; index < 7; index++) screen.result(index, 'ok');
    assert.equal(screen.form.progress.textContent, messages[language].hseInspectionProgress.replace('{answered}', 7).replace('{total}', 10));
    assert.equal(screen.form.missing.textContent, messages[language].hseInspectionMissing.replace('{count}', 3));
    assert.equal(screen.form.submit.disabled, true);
    for (let index = 7; index < 10; index++) screen.result(index, 'na');
    assert.equal(screen.form.submit.disabled, false);
    assert.equal(screen.form.missing.textContent, messages[language].hseInspectionComplete);
  }
});

await test('suggestion honours every manual outcome and never automatically suggests fail', () => {
  const failed = Object.freeze([Object.freeze({ result: 'not_ok' })]);
  assert.equal(domain.inspectionSuggestion(failed, 'pass', false), 'pass_with_notes');
  assert.equal(domain.inspectionSuggestion([{ result: 'ok' }], 'pass_with_notes', false), 'pass');
  assert.equal(domain.inspectionSuggestion([{ result: 'na' }], 'pass_with_notes', false), 'pass');
  for (const current of ['pass', 'pass_with_notes', 'fail']) assert.equal(domain.inspectionSuggestion(failed, current, true), current);
});

await test('outcome follows item changes only until the user manually selects it', async () => {
  const screen = ui(); await screen.open();
  screen.result(0, 'not_ok'); assert.equal(screen.form.elements.outcome.value, 'pass_with_notes');
  screen.result(0, 'ok'); assert.equal(screen.form.elements.outcome.value, 'pass');
  screen.field('outcome', 'fail'); screen.answerAll();
  assert.equal(screen.form.elements.outcome.value, 'fail');
  screen.field('outcome', 'pass'); screen.result(0, 'not_ok');
  assert.equal(screen.form.elements.outcome.value, 'pass');
});

await test('failed-row notes alone appear, and each choice updates aria-pressed', async () => {
  const screen = ui(); await screen.open();
  assert.ok(screen.form.rows.every(row => row.note.hidden && row.textarea.disabled));
  screen.result(2, 'not_ok'); screen.note(2, 'Synthetic evidence');
  assert.equal(screen.form.rows[2].note.hidden, false);
  assert.equal(screen.form.rows[2].textarea.disabled, false);
  assert.deepEqual(screen.form.rows[2].choices.map(control => control.attributes['aria-pressed']), ['false', 'true', 'false']);
  screen.result(2, 'ok'); assert.equal(screen.form.rows[2].note.hidden, true);
  screen.result(2, 'na'); assert.equal(screen.form.rows[2].note.hidden, true);
  assert.equal(screen.form.rows[1].note.hidden, true);
});

await test('external mode shows the statutory-examination explanation and role remains free text', async () => {
  for (const language of ['it', 'en']) {
    const screen = ui({ language }); await screen.open();
    assert.equal(screen.form.external.hidden, true);
    screen.field('mode', 'external'); assert.equal(screen.form.external.hidden, false);
    assert.ok(screen.html.includes(messages[language].hseInspectionExternalHint));
    screen.field('performerRole', 'Synthetic specialist');
    assert.equal(screen.form.elements.performerRole.value, 'Synthetic specialist');
    screen.field('mode', 'internal'); assert.equal(screen.form.external.hidden, true);
  }
});

await test('payload carries only exact request fields and strips notes from ok/na without mutation', () => {
  const fields = Object.freeze({ performedOn: '2026-11-15', performedBy: 'Synthetic inspector', performerRole: 'Synthetic role', mode: 'external', outcome: 'fail', notes: 'Synthetic general note', unexpected: 'omit' });
  const items = Object.freeze(['ok', 'not_ok', 'na'].map((result, index) => Object.freeze({ code: `check-${index}`, result, label: 'Omit label', note: 'Synthetic evidence' })));
  assert.deepEqual(domain.inspectionPayload({ asset: asset(), siteId: 'synthetic-site', fields, items }), {
    siteId: 'synthetic-site', assetId: 'synthetic-subject', performedOn: fields.performedOn, performedBy: fields.performedBy,
    performerRole: fields.performerRole, mode: fields.mode, outcome: fields.outcome, notes: fields.notes,
    items: [{ code: 'check-0', result: 'ok' }, { code: 'check-1', result: 'not_ok', note: 'Synthetic evidence' }, { code: 'check-2', result: 'na' }],
  });
  assert.equal(items[0].note, 'Synthetic evidence');
});

await test('incomplete error is localized inside the open form and every typed field survives', async () => {
  for (const language of ['it', 'en']) {
    const screen = ui({ language, respond: (_url, options) => options.method === 'POST' ? Response.json({ code: 'INSPECTION_ITEMS_INCOMPLETE', error: 'Synthetic API sentence' }, { status: 400 }) : null });
    await screen.open(); screen.answerAll(); screen.result(3, 'not_ok'); screen.note(3, 'Synthetic evidence');
    screen.field('performedOn', domain.formatDateInput('2026-10-15', screen.context.language)); screen.field('performedBy', 'Synthetic typed inspector');
    screen.field('performerRole', 'Synthetic typed role'); screen.field('mode', 'external'); screen.field('notes', 'Synthetic typed notes'); screen.field('outcome', 'fail');
    const form = screen.form, before = plain(form.elements);
    await screen.save();
    assert.equal(screen.closed, 0); assert.equal(screen.form, form); assert.equal(form.isConnected, true);
    assert.equal(form.error.hidden, false); assert.equal(form.error.textContent, messages[language].hseInspectionIncomplete);
    assert.deepEqual(plain(form.elements), before); assert.equal(form.rows[3].textarea.value, 'Synthetic evidence');
    assert.equal(form.submit.disabled, false); assert.equal(screen.notifications.length, 0);
  }
});

await test('other API failures display the API message and allow retry', async () => {
  let attempts = 0;
  const screen = ui({ respond: (_url, options) => options.method === 'POST' && attempts++ === 0 ? Response.json({ code: 'VALIDATION_ERROR', error: 'Synthetic validation detail' }, { status: 400 }) : null });
  await screen.open(); screen.answerAll(); await screen.save();
  assert.equal(screen.form.error.textContent, 'Synthetic validation detail'); assert.equal(screen.closed, 0);
  await screen.save(); await screen.settle();
  assert.equal(screen.closed, 1); assert.equal(screen.notifications.length, 1);
});

await test('success posts the exact payload, closes, refreshes subject/history and shows one due-date toast', async () => {
  for (const language of ['it', 'en']) {
    const screen = ui({ language }); await screen.open(); screen.answerAll();
    screen.result(0, 'not_ok'); screen.note(0, 'Drop old evidence'); screen.result(0, 'ok');
    screen.result(1, 'not_ok'); screen.note(1, 'Keep synthetic evidence');
    screen.result(2, 'not_ok'); screen.note(2, 'Drop unused evidence'); screen.result(2, 'na');
    screen.field('performedOn', domain.formatDateInput('2026-11-15', screen.context.language)); screen.field('performerRole', 'Synthetic specialist'); screen.field('notes', 'Synthetic report');
    const requestCount = screen.requests.length;
    await screen.save(); await screen.settle();
    const writes = screen.requests.filter(row => row.options.method === 'POST');
    assert.equal(writes.length, 1); assert.equal(writes[0].url, 'https://api.example.invalid/api/hse/inspections');
    assert.equal(writes[0].options.credentials, 'include');
    const payload = JSON.parse(writes[0].options.body);
    assert.deepEqual(payload, domain.inspectionPayload({ asset: asset(), siteId: 'synthetic-site', fields: { performedOn: '2026-11-15', performedBy: 'Synthetic inspector', performerRole: 'Synthetic specialist', notes: 'Synthetic report', mode: 'internal', outcome: 'pass_with_notes' }, items: plain(screen.form.inspectionItems) }));
    assert.ok(!('note' in payload.items[0])); assert.ok(!('note' in payload.items[2]));
    assert.equal(payload.items[1].note, 'Keep synthetic evidence');
    assert.equal(screen.closed, 1); assert.equal(screen.form.isConnected, false);
    const refreshes = screen.requests.slice(requestCount).filter(row => !row.options.method);
    assert.ok(refreshes.some(row => row.url.endsWith('/assets?siteId=synthetic-site')));
    assert.ok(refreshes.some(row => row.url.includes('/inspections?siteId=synthetic-site&assetId=synthetic-subject')));
    assert.ok(screen.main.innerHTML.includes('synthetic-inspection'));
    assert.ok(screen.main.innerHTML.includes(messages[language].inspectionStatus_ok));
    const due = screen.run("dateLabel('2027-05-15')");
    assert.deepEqual(screen.notifications, [messages[language].hseInspectionSaved.replace('{date}', due)]);
  }
});

await test('a pending save disables submission and suppresses duplicate requests', async () => {
  let release;
  const screen = ui({ respond: (_url, options) => options.method === 'POST' ? new Promise(resolve => { release = resolve; }) : null });
  await screen.open(); screen.answerAll();
  const pending = screen.save();
  assert.equal(screen.form.submit.disabled, true); assert.equal(screen.form.dataset.saving, 'true');
  screen.result(0, 'not_ok'); assert.equal(screen.form.inspectionItems[0].result, 'ok');
  await screen.save(); assert.equal(screen.requests.filter(row => row.options.method === 'POST').length, 1);
  release(Response.json({ id: 'synthetic-saved', next_due_on: '2027-05-15' })); await pending; await screen.settle();
  assert.equal(screen.closed, 1); assert.equal(screen.notifications.length, 1);
});

await test('cancel uses the existing close action and makes no write', async () => {
  const screen = ui(); await screen.open(); screen.click('close-modal');
  assert.equal(screen.closed, 1); assert.equal(screen.requests.filter(row => row.options.method === 'POST').length, 0);
});

await test('missing template fails explicitly and late template loads do not reopen a closed modal', async () => {
  const missing = ui({ templates: [] }); await missing.open();
  assert.equal(missing.form, undefined); assert.ok(missing.html.includes(messages.it.hseInspectionTemplateMissing));
  const screen = ui(); await screen.detail();
  let release; screen.context.freshApi = { listInspectionTemplates: () => new Promise(resolve => { release = resolve; }) };
  const pending = screen.run('showHseInspectionForm()'); screen.context.closeModal();
  release({ templates: [family()] }); await pending;
  assert.equal(screen.form, undefined); assert.equal(screen.closed, 1);
});

await test('new translations have IT/EN parity including placeholders; touch layout stacks without horizontal scrolling', async () => {
  assert.deepEqual(Object.keys(messages.it).sort(), Object.keys(messages.en).sort());
  const added = ['New', 'Date', 'RoleManager', 'RoleTechnician', 'ExternalHint', 'Progress', 'Missing', 'Complete', 'ItemNote', 'Notes', 'Incomplete', 'TemplateMissing', 'Saved'].map(suffix => `hseInspection${suffix}`);
  for (const key of added) {
    assert.ok(messages.it[key]); assert.ok(messages.en[key]);
    assert.deepEqual(messages.it[key].match(/\{\w+\}/g) ?? [], messages.en[key].match(/\{\w+\}/g) ?? []);
  }
  const css = await readFile(new URL('../app/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.hse-check-choices button\s*\{[^}]*min-width: 44px;[^}]*min-height: 44px;/);
  assert.match(css, /@media \(max-width: 520px\)\s*\{\s*\.hse-inspection-check \{ grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /\.hse-check-choices\s*\{[^}]*repeat\(3, minmax\(0, 1fr\)\)/);
  const sw = await readFile(new URL('../app/sw.js', import.meta.url), 'utf8');
  const version = Number(/siteassistant-v15-(\d+)/.exec(sw)?.[1]);
  assert.ok(version >= 25, `cache version ${version} must follow the current build`);
});
