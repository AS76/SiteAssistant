import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { validDate, initialView, todayActions, todayBlockedTaskMeta, recentActions, visibleModules, filterSortRecords, corePermissions, allowedTransitions, defaultViewState, navGroups } from '../app/domain.mjs';
import { messages } from '../app/i18n.mjs';
import { createOfflineStore, overlayPending } from '../app/offline.mjs';
import { mockIndexedDB, mockLocks } from './helpers/indexeddb.mjs';

const day = '2026-04-15', userId = 'synthetic-user';
const task = (id, extra = {}) => ({ id, title: `Synthetic ${id}`, siteId: 'site-a', kind: 'ordinary', status: 'todo', due: day, executor_id: userId, ...extra });
const input = extra => ({ userId, today: day, diary: [{ date: day }], ...extra });
const ids = rows => Array.from(rows, row => row.id);
const progress = id => ({ id, description: `Synthetic ${id}`, steps: [{ percent: 0 }] });

test('personal overdue tasks precede today, verification, and shared actions without duplicates', () => {
  const tasks = [task('today'), task('overdue', { due: '2026-04-01' }), task('review', { executor_id: 'other', verifier_id: userId, status: 'to_verify', due: null }),
    task('both', { verifier_id: userId, status: 'to_verify' }), task('future', { due: '2026-04-16' }), task('closed', { status: 'closed' }),
    task('other', { executor_id: 'other' })];
  const before = structuredClone(tasks);
  const result = todayActions(input({ tasks }));
  assert.deepEqual(ids(result), ['overdue', 'both', 'today', 'review']);
  assert.equal(new Set(ids(result)).size, result.length);
  assert.equal(result.at(-1).meta.label, 'todayVerify');
  assert.deepEqual(result[0].target, { view: 'tasks', filters: { id: 'overdue' } });
  assert.deepEqual(tasks, before);
});

test('five-row budget applies across personal, progress, diary and read-only deviations', () => {
  const result = todayActions(input({ tasks: [task('mine'), task('review', { executor_id: 'other', verifier_id: userId, status: 'to_verify' })],
    progress: [progress('p3'), progress('p1'), progress('p2')], diary: [], deviations: [{ id: 'd', status: 'open' }] }));
  assert.deepEqual(result.map(row => row.kind), ['task', 'task', 'progress', 'progress', 'diary']);
  assert.equal(result.length, 5);
  assert.deepEqual(ids(result).slice(2, 4), ['p1', 'p2']);
  assert.equal(todayActions(input({ tasks: Array.from({ length: 8 }, (_, i) => task(`t${i}`)) })).length, 5);
});

test('the latest operational diary entry with a next step adds a row even with five task rows', () => {
  const tasks = Array.from({ length: 5 }, (_, index) => task(`task-${index}`));
  const diary = [
    { date: '2026-04-14', shift: 'night', createdAt: '2026-04-16T01:00:00Z', next: 'Older operational day' },
    { date: day, shift: 'night', createdAt: '2026-04-16T03:00:00Z', next: '  Synthetic handover  ' },
    { date: day, shift: 'day', createdAt: '2026-04-15T16:00:00Z', next: 'Earlier shift' },
  ];
  const result = todayActions(input({ tasks, diary }));
  assert.deepEqual(result.slice(0, 5).map(row => row.kind), Array(5).fill('task'));
  assert.deepEqual(result.at(-1), {
    kind: 'diary-next', id: day, title: 'Synthetic handover', meta: { label: 'next', date: day, shift: 'night' },
    target: { view: 'diary', date: day },
  });
  for (const next of [null, '', ' \t ']) {
    const entries = diary.map(entry => entry === diary[1] ? { ...entry, next } : entry);
    assert.equal(todayActions(input({ tasks, diary: entries })).at(-1).title, 'Earlier shift');
  }
  assert.equal(todayActions(input({ tasks, diary: diary.map(entry => ({ ...entry, next: '' })) })).some(row => row.kind === 'diary-next'), false);
  assert.equal(todayActions(input({ diary, modules: { diary: false } })).some(row => row.kind === 'diary-next'), false);
});

test('the next step uses the latest operational date and compares same-day creation times across offsets', () => {
  const diary = [
    { date: '2026-04-14', shift: 'night', createdAt: '2026-04-16T05:00:00Z', next: 'Prior operational day' },
    { date: day, shift: 'day', createdAt: '2026-04-16T03:00:00Z', next: 'Latest contribution' },
    { date: day, shift: 'night', createdAt: '2026-04-16T04:30:00+02:00', next: 'Earlier contribution' },
  ];
  const next = todayActions(input({ diary })).find(row => row.kind === 'diary-next');
  assert.equal(next?.title, 'Latest contribution');
  assert.equal(next.meta.shift, 'day');
  assert.deepEqual(next.target, { view: 'diary', date: day });
});

test('unlinked executor is never personal even with a matching display name, and is last', () => {
  const tasks = [task('unlinked', { executor_id: null, assignee: 'Synthetic user', due: '2026-04-01' }),
    task('no-id', { executor_id: undefined, due: '2026-04-02' }), task('today-unlinked', { executor_id: null }),
    task('no-due', { executor_id: null, due: null }), task('mine')];
  const result = todayActions(input({ tasks, progress: [progress('p')], deviations: [{ id: 'd', title: 'Synthetic deviation', status: 'open' }] }));
  assert.deepEqual(ids(result), ['mine', 'p', 'd', 'unlinked', 'no-id']);
  for (const row of result.slice(-2)) assert.equal(row.meta.label, 'todayUnassigned');
  assert.deepEqual(ids(todayActions(input({ tasks, userId: null }))), ['unlinked', 'no-id']);
});

test('shared actions use open steps, missing diary and non-terminal known deviation statuses', () => {
  const items = [progress('open'), { id: 'unknown-step', steps: [{ percent: null }] }, { id: 'done', steps: [{ percent: 100 }] },
    { id: 'empty', steps: [] }, { id: 'imported', progressPct: 20 }];
  const before = structuredClone(items);
  const result = todayActions(input({ progress: items, deviations: [{ id: 'closed', status: 'closed' }, { id: 'rejected', status: 'rejected' },
    { id: 'unknown', status: null }, { id: 'active', status: 'work_completed' }] }));
  assert.deepEqual(ids(result), ['open', 'unknown-step', 'active']);
  assert.equal(result.at(-1).meta.label, 'todayReadOnly');
  assert.deepEqual(items, before);
  const aggregate = todayActions(input({ progress: [{ id: 'computed', progressTypeId: 'type', progressPct: 50 },
    { id: 'finished', progressTypeId: 'type', progressPct: 100 }, { id: 'unknown', progressTypeId: 'type', progressPct: null }] }));
  assert.deepEqual(ids(aggregate), ['computed']);
  assert.equal(todayActions(input({ diary: [] }))[0].target.date, day);
});

test('module denials remove action rows while Today remains a composite destination', () => {
  const data = input({ tasks: [task('mine')], progress: [progress('p')], diary: [], deviations: [{ id: 'd', status: 'open' }] });
  assert.deepEqual(todayActions({ ...data, modules: { tasks: false } }).map(row => row.kind), ['progress', 'diary', 'deviation']);
  const modules = { tasks: false, progress: false, diary: false, deviations: false, today: false };
  assert.deepEqual(todayActions({ ...data, modules }), []);
  assert.deepEqual(visibleModules(['today', 'tasks', 'overview'], modules), ['today', 'overview']);
});

test('recent actions contain three closures ordered by actual timestamps including offsets', () => {
  const tasks = [task('a', { status: 'closed', closedAt: '2026-04-15T10:00:00Z' }),
    task('b', { status: 'closed', closedAt: '2026-04-15T11:30:00+02:00' }),
    task('c', { status: 'closed', verified_at: '2026-04-16T08:00:00Z' }),
    task('d', { status: 'closed', closedAt: '2026-04-14T12:00:00Z' }), task('open', { closedAt: '2026-04-17T00:00:00Z' })];
  const before = structuredClone(tasks), result = recentActions({ tasks });
  assert.deepEqual(ids(result), ['c', 'a', 'b']);
  assert.equal(result[0].date, tasks[2].verified_at); assert.equal(result[0].title, tasks[2].title);
  assert.deepEqual(tasks, before);
});

test('undated closures sort by due descending without presenting due as closure date', () => {
  const result = recentActions({ tasks: [task('early', { status: 'closed', due: '2026-04-01' }), task('late', { status: 'closed', due: day }),
    task('undated', { status: 'closed', due: null, closedAt: 'invalid' }), task('dated', { status: 'closed', closedAt: '2026-01-01T00:00:00Z' })] });
  assert.deepEqual(ids(result), ['dated', 'late', 'early']);
  assert.equal(result[1].date, null); assert.deepEqual(recentActions({}), []);
});

test('initial view uses strict 800px boundary only when no hash was provided', () => {
  for (const width of [320, 799, 799.5]) assert.equal(initialView({ width }), 'today');
  for (const width of [800, 801, 1440]) assert.equal(initialView({ width }), 'overview');
  for (const hash of ['#overview', '#tasks', '#today', '#diary', '#report']) {
    for (const width of [390, 1440]) assert.equal(initialView({ width, hash }), hash.slice(1));
  }
  assert.equal(initialView({ width: 390, hash: '#unknown' }), 'overview');
});

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
const section = (start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `source section ${start}`);
  return source.slice(first, last);
};
const plain = value => JSON.parse(JSON.stringify(value));
function todayUi({ tasks = [], diary = [], snapshots = {}, modules = {}, memberRole = 'verifier', language = 'it', offline = false, load = async () => [] } = {}) {
  const nodes = { '#main': { innerHTML: '' }, '#attachment-form [name=file]': { click: () => clicks.push('file') } };
  const dialogs = [], routes = [], clicks = [], writes = [], requests = [];
  const read = name => options => { requests.push([name, options.siteId]); return load(name, options.siteId); };
  const context = {
    state: { sites: [{ id: 'site-a' }], tasks, diary, attachments: [], todayResources: snapshots },
    session: { user: { id: userId } }, siteId: 'site-a', actor: 'Synthetic user', offlineScope: 'synthetic-scope', storageReady: true,
    pendingOps: [], offline, storageError: false, view: 'today', taskView: 'board', filters: defaultViewState().filters,
    coreFilters: { progress: { wbsId: 'old' }, deviations: { status: 'closed', priority: 'high' } },
    freshApi: { listProgress: read('progress'), listDeviations: read('deviations') }, moduleResources: {},
    coreCache: new Map(), role: () => memberRole, canWriteTask: () => ['owner', 'editor', 'verifier'].includes(memberRole),
    permissions: () => corePermissions(memberRole), currentModules: () => modules,
    moduleVisible: module => visibleModules([module], modules).length > 0,
    todayActions, todayBlockedTaskMeta, recentActions, filterSortRecords, allowedTransitions,
    today: () => day, diaryDayAge: () => 0, operationalDay: () => ({ date: day, shift: 'day' }), validDate, notebookTime: () => '',
    language, t: key => messages[context.language][key], timeLabel: value => value,
    siteTasks: () => context.state.tasks.filter(row => row.siteId === context.siteId),
    heading: title => `<h1>${messages.it[title]}</h1>`, $: selector => nodes[selector],
    showModal: (title, html) => dialogs.push({ title, html }), formActions: () => '',
    field: () => '', wireDropzone() {},
    accountLock: run => Promise.resolve().then(run), persistState: async () => writes.push(structuredClone(context.state)),
    resetSavedViews: () => { context.filters = defaultViewState().filters; },
    go: next => { context.view = next; routes.push(next); },
  };
  runInNewContext([
    section('const esc =', 'let session ='), section('const button =', 'function toast('),
    section('const dateLabel =', 'const coreDate ='), section('const paths =', 'const button ='),
    section('async function loadPages(', 'async function loadData('),
    section('function coreResource(', 'const coreData ='),
    section('function todayResource(', 'function renderOverview()'),
    section('function filteredTasks()', 'const currentViewState ='),
    section('const canEditTask =', 'const canCreateSite ='),
    section('const lightTransitions =', 'function lightTaskButton('),
    section('function showEntryForm(', '// Photos:'),
    section('function showAttachmentForm(', 'async function openAttachment('),
  ].join('\n'), context);
  context.render = () => context.renderToday();
  return { context, nodes, dialogs, routes, clicks, writes, requests,
    async settle() { await Promise.all([...context.coreCache.values()].flatMap(cache => [...cache.values()].map(entry => entry.promise))); } };
}
function todayClick(context, dataset) {
  let click;
  context.document = { addEventListener: (_event, handler) => { click = handler; } };
  for (const [, name] of source.matchAll(/(?:async )?function (\w+)\(/g)) if (!(name in context)) context[name] = () => {};
  runInNewContext(section("document.addEventListener('click',", "document.addEventListener('submit',"), context);
  click({ target: { closest: () => ({ dataset }) } });
}

test('Today renderer scopes to active site, escapes titles and shows resource loading', () => {
  const { context, nodes, writes } = todayUi({ tasks: [
    task('mine', { title: '<img src=x onerror=bad()>' }),
    task('verify', { status: 'to_verify', verifier_id: userId, submitted_by_id: 'other' }),
    task('future', { due: '2026-04-16' }), task('recent', { status: 'closed' }), task('other-site', { siteId: 'site-b' }),
  ] });
  context.renderToday();
  const html = nodes['#main'].innerHTML;
  assert.match(html, /&lt;img src=x onerror=bad\(\)&gt;/); assert.doesNotMatch(html, /<img|other-site/);
  assert.equal((html.match(/data-command="today-quick"/g) || []).length, 4);
  assert.match(html, /class="notebook-primary" data-command="transition" data-id="verify" data-to="closed"/);
  assert.equal((html.match(/class="notebook-primary"/g) || []).length, 1);
  assert.match(html, /id="today-upcoming"[\s\S]*data-id="future"[\s\S]*In arrivo/);
  assert.ok(html.indexOf('today-now') < html.indexOf('today-quick'));
  assert.ok(html.indexOf('today-quick') < html.indexOf('today-recent'));
  assert.equal(writes.length, 0);
});

const contextLabels = {
  it: { blocked: 'Bloccata', reason: 'Motivo', one: '1 giorno di ritardo', three: '3 giorni di ritardo', zero: '0 giorni di ritardo',
    date: '14 apr 2026', history: 'Cronologia', next: 'Prossimo passo', shift: 'Turno notturno' },
  en: { blocked: 'Blocked', reason: 'Reason', one: '1 day overdue', three: '3 days overdue', zero: '0 days overdue',
    date: '14 Apr 2026', history: 'History', next: 'Next step', shift: 'Night shift' },
};
const rowMarkup = (html, id) => [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].find(([, row]) => row.includes(`data-id="${id}"`))?.[1];

for (const [language, labels] of Object.entries(contextLabels)) {
  test(`Today renders blocked context in Now and Work and dispatches detail and history (${language})`, () => {
    const { context, nodes } = todayUi({ language, tasks: [
      task('known', { status: 'blocked', due: '2026-04-12', last_block_note: 'Missing <guard>' }),
      task('unknown', { status: 'blocked', due: '2026-04-14', last_block_note: '  ', executor_id: 'other' }),
      task('due-today', { status: 'blocked', events: [{ to_status: 'blocked', reason: 'Synthetic event reason' }] }),
    ] });
    context.renderToday();
    const html = nodes['#main'].innerHTML;
    const known = rowMarkup(html, 'known'), unknown = rowMarkup(html, 'unknown'), dueToday = rowMarkup(html, 'due-today');
    assert.ok(html.indexOf('id="today-now"') < html.indexOf(known));
    assert.ok(html.indexOf(known) < html.indexOf('id="today-work"'));
    assert.ok(html.indexOf('id="today-work"') < html.indexOf(unknown));
    assert.match(known, new RegExp(`▲</span> ${labels.blocked}</span>\\s*<strong>Synthetic known</strong>\\s*<time[^>]*overdue[^>]*>`));
    assert.ok(known.includes(`<span class="today-row-sub"><span class="today-row-clamp">${labels.reason}: Missing &lt;guard&gt;</span><span class="num"> · ${labels.three}</span></span>`));
    assert.ok(unknown.includes(`<span class="today-row-sub"><span class="num">${labels.one}</span></span>`));
    assert.ok(dueToday.includes(`${labels.reason}: Synthetic event reason</span><span class="num"> · ${labels.zero}`));
    assert.doesNotMatch(dueToday, /class="[^"]*\boverdue\b/);
    assert.match(known, new RegExp(`data-command="task-history" data-id="known">${labels.history}</button>`));
    const details = [];
    context.showDetail = (id, options) => details.push([id, options?.history ?? false]);
    for (const [, command, id] of known.matchAll(/data-command="([^"]+)"[^>]*data-id="([^"]+)"/g)) todayClick(context, { command, id });
    assert.deepEqual(details, [['known', false], ['known', true]]);
  });

  test(`Today shows the latest nonblank next step and opens its diary date (${language})`, () => {
    const diaryDate = '2026-04-14';
    const { context, nodes, routes } = todayUi({ language, diary: [
      { siteId: 'site-b', date: day, shift: 'night', next: 'Other site handover' },
      { siteId: 'site-a', date: day, shift: 'day', next: ' \t ' },
      { siteId: 'site-a', date: diaryDate, shift: 'day', createdAt: '2026-04-14T16:00:00Z', next: 'Earlier shift' },
      { siteId: 'site-a', date: diaryDate, shift: 'night', createdAt: '2026-04-15T01:00:00Z', next: 'Check <guard>' },
    ] });
    context.renderToday();
    const html = nodes['#main'].innerHTML;
    const next = rowMarkup(html, diaryDate);
    assert.match(next, /data-kind="diary-next"[^>]*>\s*<span[^>]*><svg[\s\S]*<strong class="today-row-clamp">Check &lt;guard&gt;<\/strong>/);
    assert.ok(next.includes(`${labels.next} · ${labels.date} · ${labels.shift}`));
    assert.doesNotMatch(html, /Other site handover|Earlier shift/);
    todayClick(context, { command: 'today-open', kind: 'diary-next', id: diaryDate });
    assert.equal(context.reportDate, diaryDate);
    assert.deepEqual(routes, ['diary']);
    context.state.diary = context.state.diary.map(entry => ({ ...entry, next: null }));
    context.renderToday();
    assert.doesNotMatch(nodes['#main'].innerHTML, /data-kind="diary-next"/);
  });
}

test('denied task module hides tasks, recent closures and task photo destinations, even on direct commands', () => {
  const { context, nodes, routes } = todayUi({ tasks: [task('mine'), task('closed', { status: 'closed' })], modules: { tasks: false } });
  context.renderToday(); const html = nodes['#main'].innerHTML;
  assert.doesNotMatch(html, /data-action="verify"|Synthetic mine|Synthetic closed/);
  assert.deepEqual(plain(context.todayPhotoTargets()), []);
  context.runTodayQuick('verify'); context.openTodayAction({ dataset: { kind: 'task', id: 'mine' } });
  assert.deepEqual(routes, []);
});

test('row targets reset unrelated filters and open tasks, progress, diary and read-only deviation lists directly', () => {
  const { context, routes } = todayUi({ tasks: [task('mine')], snapshots: { 'site-a': { progress: [progress('p')], deviations: [{ id: 'd', title: 'Synthetic deviation', status: 'open' }] } } });
  const open = (kind, id) => context.openTodayAction({ dataset: { kind, id } });
  context.filters = { ...context.filters, search: 'old', priority: 'urgent', closable: true };
  open('task', 'mine'); assert.deepEqual(ids(context.filteredTasks()), ['mine']); assert.equal(context.taskView, 'list');
  open('progress', 'p'); assert.deepEqual(plain(context.coreFilters.progress), { wbsId: '', id: 'p' });
  open('diary', day); assert.equal(context.reportDate, day);
  open('deviation', 'd'); assert.equal(context.deviationView, 'list'); assert.equal(context.coreFilters.deviations.id, 'd');
  assert.equal(context.coreFilters.deviations.status, ''); assert.equal(context.coreFilters.deviations.priority, '');
  assert.deepEqual(routes, ['tasks', 'progress', 'diary', 'deviations']);
});

test('close shortcut filters actual ordinary, permitted, independent reviews and respects pending operations', () => {
  const valid = task('valid', { status: 'to_verify', verifier_id: userId, submitted_by_id: 'other' });
  const { context } = todayUi({ tasks: [valid, { ...valid, id: 'other-reviewer', verifier_id: 'other' },
    { ...valid, id: 'legacy', verifier_id: null }, { ...valid, id: 'self', submitted_by_id: userId },
    { ...valid, id: 'missing-submitter', submitted_by_id: null }, { ...valid, id: 'corrective', kind: 'corrective' },
    { ...valid, id: 'todo', status: 'todo' }, { ...valid, id: 'pending' }] });
  context.pendingOps = [{ entity_id: 'pending', op_type: 'transition_task' }];
  context.runTodayQuick('verify');
  assert.equal(context.view, 'tasks'); assert.equal(context.taskView, 'light');
  assert.deepEqual(ids(context.filteredTasks()), ['valid']);
  const owner = todayUi({ tasks: [{ ...valid, verifier_id: null }], memberRole: 'owner' });
  owner.context.runTodayQuick('verify'); assert.deepEqual(ids(owner.context.filteredTasks()), ['valid']);
});

test('diary shortcut opens the current-day form in one tap; progress resets stale filters', () => {
  const { context, dialogs, routes } = todayUi({ memberRole: 'editor' });
  context.reportDate = '2026-01-01'; context.runTodayQuick('diary');
  assert.equal(context.reportDate, day); assert.match(dialogs[0].html, /id="entry-form"/); assert.match(dialogs[0].html, /2026-04-15/);
  context.runTodayQuick('progress'); assert.deepEqual(plain(context.coreFilters.progress), { wbsId: '' });
  assert.deepEqual(routes, ['progress']);
});

test('photo shortcut offers at most five permitted current-site targets and opens camera picker on second tap', () => {
  const { context, dialogs, clicks } = todayUi({ memberRole: 'editor', tasks: [...Array.from({ length: 8 }, (_, i) => task(`t${i}`)), task('closed', { status: 'closed' }), task('other-site', { siteId: 'site-b' })],
    diary: [{ id: 'entry', siteId: 'site-a', date: day, shift: 'day' }, { id: 'old', siteId: 'site-a', date: '2026-01-01' }] });
  context.runTodayQuick('photo');
  assert.equal((dialogs[0].html.match(/data-command="today-photo-target"/g) || []).length, 5);
  assert.doesNotMatch(dialogs[0].html, /other-site|data-id="closed"|data-id="old"/);
  context.openTodayPhoto('diary', 'entry');
  assert.match(dialogs[1].html, /id="attachment-form" data-entity-type="diary" data-entity-id="entry"/);
  assert.match(dialogs[1].html, /accept="image\/\*" capture="environment"/); assert.deepEqual(clicks, ['file']);
  context.openTodayPhoto('task', 'closed'); assert.equal(dialogs.length, 2);
});

test('viewers can open progress but cannot invoke write shortcuts, and all denied modules produce no quick actions', () => {
  const { context, nodes, dialogs, routes } = todayUi({ memberRole: 'viewer', tasks: [task('mine')] });
  for (const action of ['verify', 'diary', 'photo']) context.runTodayQuick(action);
  assert.deepEqual(dialogs, []); assert.deepEqual(routes, []);
  context.runTodayQuick('progress'); assert.deepEqual(routes, ['progress']);
  context.renderToday(); assert.equal((nodes['#main'].innerHTML.match(/data-action="\w+" disabled/g) || []).length, 2);
  const denied = todayUi({ modules: { tasks: false, diary: false, progress: false, deviations: false } });
  denied.context.renderToday(); assert.doesNotMatch(denied.nodes['#main'].innerHTML, /data-command="today-quick"/);
});

test('existing offline mirror reloads Today with cached resources and a derived queue count including zero', async () => {
  const store = createOfflineStore({ indexedDB: mockIndexedDB(), locks: mockLocks() });
  const ui = todayUi({ tasks: [task('mine')], offline: true });
  ui.context.persistState = () => store.setMirror('state:synthetic-scope', plain(ui.context.state));
  ui.context.rememberTodayResource('progress', [progress('cached-progress')]);
  await ui.context.accountLock(async () => {});
  const saved = await store.getMirror('state:synthetic-scope'); assert.ok(saved);
  const reloaded = todayUi({ tasks: saved.tasks, snapshots: saved.todayResources, offline: true });
  const ops = [{ entity_id: 'queued', op_type: 'create_diary', payload: { siteId: 'site-a', date: day }, status: 'pending' }];
  reloaded.context.state = overlayPending(reloaded.context.state, ops); reloaded.context.pendingOps = ops;
  reloaded.context.renderToday(); let html = reloaded.nodes['#main'].innerHTML;
  assert.match(html, /cached-progress/); assert.doesNotMatch(html, /data-kind="diary"/);
  assert.ok(html.includes(messages.it.todayCached)); assert.match(html, /<strong class="num">1<\/strong> scritture in coda/);
  reloaded.context.pendingOps = []; reloaded.context.renderToday(); html = reloaded.nodes['#main'].innerHTML;
  assert.match(html, /<strong class="num">0<\/strong> scritture in coda/);
  reloaded.context.siteId = 'site-b'; reloaded.context.renderToday(); assert.doesNotMatch(reloaded.nodes['#main'].innerHTML, /cached-progress/);
});

test('actual bootstrap and hash listener preserve hash-free mobile default and allow returning to Overview', () => {
  const listeners = {}, location = { hash: '' };
  let renders = 0;
  const context = { initialView, location, window: { innerWidth: 390, addEventListener: (event, fn) => { listeners[event] = fn; } },
    closeModal() {}, render: () => renders++, $: () => ({ focus() {} }) };
  const bootstrap = source.split('\n').find(line => line.startsWith('let view ='));
  const listener = source.split('\n').find(line => line.startsWith("window.addEventListener('hashchange'"));
  runInNewContext(`${bootstrap}\nlet reportPrintIntent = null;\n${listener}\nglobalThis.getView = () => view;`, context);
  assert.equal(context.getView(), 'today'); assert.equal(location.hash, '');
  location.hash = '#overview'; listeners.hashchange(); assert.equal(context.getView(), 'overview');
  location.hash = '#today'; listeners.hashchange(); assert.equal(context.getView(), 'today');
  location.hash = ''; listeners.hashchange(); assert.equal(context.getView(), 'overview'); assert.equal(renders, 3);
});

test('every Today label and metadata key is translated in Italian and English', () => {
  const keys = new Set([...Object.keys(messages.it), ...Object.keys(messages.en)].filter(key => key.startsWith('today')));
  for (const key of keys) for (const language of ['it', 'en']) assert.equal(typeof messages[language][key], 'string', `${language}: ${key}`);
  assert.equal(messages.it.todayVerifyTasks, 'Verifica attività'); assert.equal(messages.it.todayTakePhoto, 'Scatta foto');
});


test('mobile navigation starts with Today and desktop keeps every group plus Today while respecting denials', () => {
  for (const width of [390, 800, 1280]) {
    const { context, nodes } = todayUi({ modules: { tasks: false } });
    const node = () => ({ innerHTML: '', setAttribute() {}, insertAdjacentHTML() {}, querySelectorAll: () => [], append(child) { child.parentElement = this; } });
    context.$ = selector => nodes[selector] ??= node();
    context.window = { matchMedia: query => ({ matches: query.includes('1180') ? width >= 1180 : width < 640 }) };
    context.document = { documentElement: {} }; context.sessionStorage = { getItem: () => null };
    Object.assign(context, { language: 'it', loading: false, renderOffline() {}, currentSite: () => undefined, icon: () => '', navGroups, visibleModules });
    runInNewContext(section('const NAV_ITEMS =', 'const coreCache =') + section('const DEMO_NOTICE_KEY', 'function dueMarkup('), context);
    context.renderChrome();
    const html = nodes['#navigation'].innerHTML;
    assert.doesNotMatch(html, /href="#tasks"/);
    if (width < 1180) assert.match(html, /^<a href="#today"/);
    else {
      assert.match(html, /href="#overview"/);
      assert.match(html, /^<a href="#today"/);
      assert.equal((html.match(/<details class="nav-group"/g) || []).length, 3);
      assert.equal((html.match(/<a href=/g) || []).length, 13);
    }
  }
});

test('loaded resources refresh the existing mirror and live cache, and late writes cannot cross account scope', async () => {
  const { context, writes } = todayUi();
  const entry = { data: [progress('old')] };
  context.coreCache.set('site-a', new Map([['progress', entry]]));
  context.rememberTodayResource('progress', [progress('new')]);
  await context.accountLock(async () => {});
  assert.deepEqual(ids(context.todayResource('progress')), ['new']); assert.equal(writes.length, 1);
  context.rememberTodayResource('progress', [progress('next')]);
  context.offlineScope = 'other-account'; context.state = { tasks: [], diary: [] };
  await context.accountLock(async () => {}); assert.equal(writes.length, 1);
});


test('cold Today loads progress and deviations itself, reuses each site cache, and ignores late site responses', async () => {
  let resolveA;
  const ui = todayUi({ diary: [{ siteId: 'site-a', date: day }], load: async (name, site) => {
    if (name === 'progress' && site === 'site-a') return new Promise(resolve => { resolveA = resolve; });
    return name === 'progress' ? [progress(`progress-${site}`)] : [{ id: `deviation-${site}`, status: 'open' }];
  } });
  ui.context.renderToday();
  assert.deepEqual(ui.requests, [['progress', 'site-a'], ['deviations', 'site-a']]);
  assert.match(ui.nodes['#main'].innerHTML, /Avanzamento · Caricamento/);
  assert.match(ui.nodes['#main'].innerHTML, /class="skeleton-list" aria-hidden="true"/);
  ui.context.siteId = 'site-b'; ui.context.renderToday();
  resolveA([progress('progress-site-a')]); await ui.settle();
  assert.match(ui.nodes['#main'].innerHTML, /progress-site-b|deviation-site-b/);
  assert.doesNotMatch(ui.nodes['#main'].innerHTML, /progress-site-a|deviation-site-a/);
  ui.context.siteId = 'site-a'; ui.context.renderToday();
  assert.match(ui.nodes['#main'].innerHTML, /progress-site-a/);
  assert.equal(ui.requests.length, 4);
  assert.ok(ui.context.state.todayResources['site-a'].progress.length);
});

test('failed resources retain loaded rows with inline retry while successful empty resources have an explicit state', async () => {
  const ui = todayUi({ snapshots: { 'site-a': { progress: [progress('stale')] } }, load: async name => {
    if (name === 'progress') throw new Error('Synthetic hidden detail');
    return [];
  } });
  ui.context.renderToday(); await ui.settle();
  const html = ui.nodes['#main'].innerHTML;
  assert.match(html, /role="alert"/); assert.match(html, /data-command="today-retry" data-resource="progress"/);
  assert.ok(html.includes(messages.it.todayResourceEmpty));
  assert.doesNotMatch(html, /hidden detail/);
  assert.match(html, /data-id="stale"/);
  ui.context.freshApi.listProgress = async () => [progress('recovered')];
  todayClick(ui.context, { command: 'today-retry', resource: 'progress' });
  assert.match(ui.nodes['#main'].innerHTML, /data-id="stale"/);
  await ui.settle(); assert.match(ui.nodes['#main'].innerHTML, /data-id="recovered"/);
});

test('hidden Today resources are never requested and offline missing data do not appear empty', async () => {
  const denied = todayUi({ modules: { progress: false, deviations: false } });
  denied.context.renderToday(); await denied.settle(); assert.deepEqual(denied.requests, []);
  const disconnected = todayUi({ offline: true, modules: { tasks: false, diary: false } });
  disconnected.context.renderToday(); assert.deepEqual(disconnected.requests, []);
  assert.ok(disconnected.nodes['#main'].innerHTML.includes(messages.it.todayUnavailableOffline));
  assert.ok(disconnected.nodes['#main'].innerHTML.includes(messages.it.todayIncomplete));
  assert.ok(!disconnected.nodes['#main'].innerHTML.includes(messages.it.todayEmpty));
});
