import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { createApi, ApiError } from '../app/api.mjs';
import { corePermissions } from '../app/domain.mjs';
import { messages } from '../app/i18n.mjs';

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
const event = (action = 'create', changes = { name: 'Synthetic record' }, extra = {}) => ({
  action, changes: JSON.stringify(changes), entity_type: 'tool', entity_id: '12345678-1234-4123-8123-123456789abc',
  actor_name: 'Synthetic editor', at: '2026-11-10T10:15:00.000Z', ...extra,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Exercise the real shared renderer and toggle handler without sockets or a browser process.
function auditUi(currentRole = 'owner', view = 'tools', load = async () => []) {
  const calls = [];
  let panel;
  const makePanel = () => ({
    open: false, isConnected: true, body: { innerHTML: '' },
    querySelector() { return this.body; },
    addEventListener(type, listener) { assert.equal(type, 'toggle'); this.toggle = listener; },
  });
  const main = {
    html: '',
    set innerHTML(value) { this.html = value; if (panel) panel.isConnected = false; panel = undefined; },
    insertAdjacentHTML(position, html) {
      this.html += html;
      if (html.includes('id="audit-panel"')) panel = makePanel();
    },
    setAttribute() {},
  };
  const context = createContext({
    messages, language: 'it', currentRole, view, siteId: 'site-1', session: { user: { id: 'user-1' } },
    offline: false, navigator: { onLine: true }, columnFiltersOn: false, coreFilters: {},
    $: selector => selector === '#main' ? main : selector === '#audit-panel' ? panel : null,
    heading: () => '<h1>Module</h1>', button: () => '', empty: () => '<p>Empty</p>',
    moduleResources: { tools: [], certifications: [], hse: [], progress: [] }, coreResource: () => ({}),
    renderDeviations: () => '', renderProgress: () => '', renderBookings: () => '', renderImpacts: () => '',
    renderTools: () => '<section>Tools</section>', renderCertifications: () => '<section>Certifications</section>',
    renderHse: () => '<section>HSE</section>', enhanceCoreTables: () => {},
    freshApi: { listAuditEvents: async input => { calls.push(JSON.parse(JSON.stringify(input))); return load(input); } },
  });
  context.role = () => context.currentRole;
  context.permissions = () => corePermissions(context.currentRole);
  for (const [start, end] of [
    ['const esc =', '\nlet session'], ['const t =', 'const personName'], ['const timeLabel =', 'const paths ='],
    ['const errorKeys =', 'function clearSession('], ['function renderCore()', '// Sorting and per-column'],
  ]) runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
  return {
    context, calls, main, get panel() { return panel; },
    run: script => runInContext(script, context),
    renderEvents(events) { context.events = events; return runInContext('renderAuditEvents(events)', context); },
    async toggle(open) { panel.open = open; await panel.toggle?.(); },
    forgePanel() { panel = makePanel(); },
  };
}

test('audit client encodes read filters, keeps wire snapshots intact and uses the existing errors', async () => {
  const calls = [], rows = [event()];
  const api = createApi({ baseUrl: 'https://api.example.invalid', fresh: true, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return Response.json(rows);
  } });
  assert.deepEqual(await api.listAuditEvents({ siteId: 'site /&', entityType: 'hse_event', limit: 20 }), rows);
  assert.equal(calls[0].url, 'https://api.example.invalid/api/audit-events?site_id=site+%2F%26&entity_type=hse_event&limit=20');
  assert.deepEqual(calls[0].options, { credentials: 'include', cache: 'reload' });
  await api.listAuditEvents({ siteId: 'site-1', entityType: 'tool' });
  assert.ok(calls[1].url.endsWith('&limit=20'));
  const failing = createApi({ fetchImpl: async () => Response.json({ error: 'Synthetic denial' }, { status: 403 }) });
  await assert.rejects(() => failing.listAuditEvents({ siteId: 'site-1' }), error => error instanceof ApiError && error.status === 403);
});

test('audit vocabulary and field labels render in both languages', () => {
  const keys = ['auditTitle', 'auditCreated', 'auditUpdated', 'auditDeleted', 'auditUnknownUser', 'auditRecentOnly',
    'auditMore', 'auditLoading', 'auditError', 'auditEmpty'];
  for (const language of ['it', 'en']) {
    for (const key of keys) assert.equal(typeof messages[language][key], 'string', `${language}.${key}`);
    const ui = auditUi(); ui.context.language = language;
    const html = ui.renderEvents([event('update', { severity: { from: 'low', to: 'high' } }, { entity_type: 'hse_event', actor_name: null })]);
    assert.ok(html.includes(messages[language].auditUpdated));
    assert.ok(html.includes(messages[language].auditUnknownUser));
    assert.ok(html.includes(messages[language].hseSeverity));
  }
});

test('all three core views show a closed audit panel only to owners and verifiers and never fetch on render', async () => {
  for (const [view, entityType] of [['hse', 'hse_event'], ['certifications', 'certification'], ['tools', 'tool']]) {
    for (const role of ['owner', 'verifier', 'editor', 'viewer', undefined]) {
      const ui = auditUi(role, view);
      // The default parameter models owner; explicitly clear the role for an unauthenticated context.
      ui.context.currentRole = role;
      ui.run('renderCore()');
      assert.equal(ui.main.html.includes('id="audit-panel"'), ['owner', 'verifier'].includes(role), `${view}/${role}`);
      assert.equal(ui.calls.length, 0);
      if (['owner', 'verifier'].includes(role)) {
        assert.doesNotMatch(ui.main.html, /<details[^>]*\bopen\b/);
        assert.ok(ui.main.html.indexOf('id="audit-panel"') > ui.main.html.indexOf('</section>'));
        await ui.toggle(true);
        assert.deepEqual(ui.calls, [{ siteId: 'site-1', entityType, limit: 20 }]);
      } else {
        ui.forgePanel(); ui.run('bindAuditPanel()'); await ui.toggle(true);
        assert.equal(ui.calls.length, 0);
      }
    }
  }
  const other = auditUi('owner', 'progress'); other.run('renderCore()');
  assert.doesNotMatch(other.main.html, /audit-panel/);
});

test('audit fetches once per opening, shows loading and empty states, and refreshes after closing', async () => {
  let pending = deferred();
  const ui = auditUi('verifier', 'hse', () => pending.promise);
  ui.run('renderCore()');
  const opening = ui.toggle(true);
  assert.ok(ui.panel.body.innerHTML.includes(messages.it.auditLoading));
  assert.match(ui.panel.body.innerHTML, /role="status"/);
  await ui.toggle(true); assert.equal(ui.calls.length, 1);
  pending.resolve([]); await opening;
  assert.ok(ui.panel.body.innerHTML.includes(messages.it.auditEmpty));
  await ui.toggle(false); assert.equal(ui.calls.length, 1);
  pending = deferred();
  const reopening = ui.toggle(true); assert.equal(ui.calls.length, 2);
  pending.resolve([event()]); await reopening;
  assert.ok(ui.panel.body.innerHTML.includes('Synthetic record'));
  ui.run('renderCore()'); assert.equal(ui.calls.length, 2);
});

test('audit renders three actions, actor fallback, local time and at most four changed fields', () => {
  const ui = auditUi();
  const html = ui.renderEvents([
    event(), event('delete', { event_no: 'SYN-002' }, { entity_type: 'hse_event', actor_name: null }),
    event('update', { name: { from: 'Old record', to: 'New record' }, code: { from: null, to: '' },
      status: { from: 'available', to: 'maintenance' }, synthetic_field: { from: 0, to: false },
      notes: { from: null, to: 'Hidden note' }, location: { from: null, to: 'Hidden location' } }),
  ]);
  for (const label of ['Creata', 'Modificata', 'Eliminata', 'utente sconosciuto', 'Synthetic editor', 'New record', 'SYN-002',
    'Nome: Old record → New record', 'Codice / matricola: null → &quot;&quot;', 'Stato: available → maintenance',
    'synthetic_field: 0 → false', '+2 altri']) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /Hidden note|Hidden location/);
  const when = new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(event().at));
  assert.ok(html.includes(when));
  assert.match(html, /<time datetime="2026-11-10T10:15:00.000Z">/);
  const four = ui.renderEvents([event('update', Object.fromEntries(['a', 'b', 'c', 'd'].map(key => [key, { from: 0, to: 1 }]))) ]);
  assert.doesNotMatch(four, /altri/);
});

test('audit record names come only from snapshots or diffs, otherwise the first eight id characters', () => {
  const ui = auditUi();
  for (const action of ['create', 'update', 'delete']) {
    for (const field of ['name', 'event_no', 'title', 'deviation_no']) {
      const changes = { [field]: action === 'update' ? { from: 'Old synthetic', to: 'Synthetic name' } : 'Synthetic name' };
      assert.match(ui.renderEvents([event(action, changes)]), /class="audit-record">Synthetic name<\/p>/);
    }
    assert.match(ui.renderEvents([event(action, {})]), /class="audit-record">12345678<\/p>/);
  }
  assert.match(ui.renderEvents([event('update', { name: { from: 'Old synthetic', to: null } })]), /class="audit-record">Old synthetic<\/p>/);
  assert.match(ui.renderEvents([event('update', { issued_on: { from: null, to: '2026-01-01' } }, { entity_type: 'certification' })]), /Rilascio: null → 2026-01-01/);
});

test('audit escapes all record, actor, field and value text and notes the 20-row limit', () => {
  const ui = auditUi();
  const html = ui.renderEvents([event('update', { name: { from: '<img src=x>', to: '<script>synthetic</script>' },
    '<b>field</b>': { from: '<i>old</i>', to: '<b>new</b>' } }, { actor_name: '<img src=x>' })]);
  assert.doesNotMatch(html, /<img|<script|<b>|<i>/);
  assert.ok(html.includes('&lt;script&gt;synthetic&lt;/script&gt;'));
  assert.ok(html.includes('&lt;b&gt;field&lt;/b&gt;'));
  assert.ok(ui.renderEvents(Array.from({ length: 20 }, () => event())).includes(messages.it.auditRecentOnly));
  assert.ok(!ui.renderEvents([event()]).includes(messages.it.auditRecentOnly));
});

test('audit shows the application error inside the panel and retries on the next opening', async () => {
  const ui = auditUi('owner', 'tools', async () => { throw new ApiError('apiUnavailable'); });
  ui.run('renderCore()'); await ui.toggle(true);
  assert.match(ui.panel.body.innerHTML, /role="alert"/);
  assert.ok(ui.panel.body.innerHTML.includes(messages.it.auditError));
  assert.ok(ui.panel.body.innerHTML.includes(messages.it.apiUnavailable));
  await ui.toggle(false); await ui.toggle(true); assert.equal(ui.calls.length, 2);
});

test('late audit responses cannot replace a new opening or render into a different context', async () => {
  const first = deferred(), second = deferred(); let count = 0;
  const ui = auditUi('owner', 'tools', () => (++count === 1 ? first : second).promise);
  ui.run('renderCore()'); const opening = ui.toggle(true);
  await ui.toggle(false); const reopening = ui.toggle(true);
  second.resolve([event('create', { name: 'New snapshot' })]); await reopening;
  first.resolve([event('create', { name: 'Stale snapshot' })]); await opening;
  assert.match(ui.panel.body.innerHTML, /New snapshot/);
  assert.doesNotMatch(ui.panel.body.innerHTML, /Stale snapshot/);
  for (const change of ["siteId = 'site-2'", "view = 'hse'", "session.user.id = 'user-2'", "currentRole = 'editor'", '']) {
    const pending = deferred(), other = auditUi('owner', 'tools', () => pending.promise);
    other.run('renderCore()'); const loading = other.toggle(true), body = other.panel.body;
    if (change) other.run(change); else other.panel.isConnected = false;
    pending.resolve([event('create', { name: 'Stale private snapshot' })]); await loading;
    assert.doesNotMatch(body.innerHTML, /Stale private snapshot/);
  }
});
