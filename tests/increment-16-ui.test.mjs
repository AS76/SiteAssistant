import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { createApi, deviationFromApi, progressFromApi, bookingFromApi, impactFromApi } from '../app/api.mjs';
import { offlineBannerState, DEVIATION_STATUSES, IMPACT_RESULTS, impactTransitions, corePermissions, filterSortRecords, impactTotals, groupBookings, progressWithHours, flattenWbs, sanitizeViewState, viewStatePayload, lightTaskRows, transitionNeedsDialog, transitionRequirements, allowedTransitions, transitionPayload, counts, STATUSES, PRIORITIES, TASK_KINDS, taskKindLabelKey } from '../app/domain.mjs';
import { messages } from '../app/i18n.mjs';

test('deviation wire mapping preserves nulls, source timestamps and raw content', () => {
  const wire = { id: 'dev-a', site_id: 'site-a', deviation_no: 'DEMO-01', problem_description: '<b>Example</b>', creation_date: '2026-01-01T01:02:03.123456Z', due_date: null, completed_tasks_pct: '0.000', actual_cost: '9007199254740993.01', raw: { original_key: null }, links: [{ entity_type: 'task', entity_id: 'task-a' }] };
  const mapped = deviationFromApi(wire);
  assert.equal(mapped.siteId, 'site-a'); assert.equal(mapped.deviationNo, 'DEMO-01');
  assert.equal(mapped.problemDescription, wire.problem_description); assert.equal(mapped.creationDate, wire.creation_date);
  assert.equal(mapped.dueDate, null); assert.equal(mapped.completedTasksPct, '0.000'); assert.equal(mapped.actualCost, wire.actual_cost);
  assert.deepEqual(mapped.links, [{ entityType: 'task', entityId: 'task-a' }]);
  assert.deepEqual(mapped.raw, { original_key: null }); assert.equal(mapped.site_id, undefined);
  assert.equal(wire.links[0].entity_id, 'task-a');
});
test('progress and booking wire mapping retains zero, nullable flags and numeric strings', () => {
  const progress = progressFromApi({ id: 'spi-a', wbs_id: null, progress_pct: 0, planned_progress_pct: '25.5', booked_hours: 0, has_notes: null, has_files: false, expected_delay: 'raw delay', source_row: '21' });
  assert.deepEqual(progress, { id: 'spi-a', wbsId: null, progressPct: 0, plannedProgressPct: '25.5', bookedHours: 0, hasNotes: null, hasFiles: false, expectedDelay: 'raw delay', sourceRow: '21' });
  assert.deepEqual(bookingFromApi({ id: 'booking-a', work_day_id: 'day-a', site_progress_item_id: 'spi-a', hours: 0, created_by: null }), { id: 'booking-a', workDayId: 'day-a', siteProgressItemId: 'spi-a', hours: 0, createdBy: null });
});
test('impact wire mapping maps linked deviations without rounding money', () => {
  const mapped = impactFromApi({ claim_amount: '12345678901234567890.12', settlement_amount: null, closed_at: null, deviations: [{ deviation_no: 'DEMO-02', assigned_to: null }] });
  assert.deepEqual(mapped, { claimAmount: '12345678901234567890.12', settlementAmount: null, closedAt: null, deviations: [{ deviationNo: 'DEMO-02', assignedTo: null }] });
});
test('core API lists encode camelCase filters and map returned records', async () => {
  const calls = [], api = createApi({ baseUrl: '/', fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json([{ site_id: 'site-a', operational_date: '2026-01-01', first_name: 'Example' }]); } });
  for (const method of ['listDeviations', 'listProgress', 'listBookings', 'listImpacts', 'listWorkDays', 'listEmployees']) {
    const rows = await api[method]({ siteId: 'site-a', status: '', wbsId: undefined });
    assert.equal(rows[0].siteId, 'site-a'); assert.equal(rows[0].operationalDate, '2026-01-01'); assert.equal(rows[0].firstName, 'Example');
  }
  // Paginated lists ask for a full page so the UI keeps showing every record it loads.
  assert.deepEqual(calls.map(call => call.url), ['/api/deviations', '/api/site-progress', '/api/time-bookings', '/api/cost-impacts', '/api/work-days', '/api/employees']
    .map(path => ['/api/deviations', '/api/site-progress', '/api/time-bookings'].includes(path)
      ? `${path}?limit=200&site_id=site-a` : `${path}?site_id=site-a`));
  await api.listBookings({ siteId: 'site-a', workDayId: 'day/a' });
  assert.match(calls.at(-1).url, /work_day_id=day%2Fa/);
  await api.listProgress({ siteId: 'site-a', wbsId: 'wbs-a' }); assert.match(calls.at(-1).url, /wbs_id=wbs-a/);
  for (const call of calls) assert.equal(call.options.credentials, 'include');
});
test('core API detail, booking and claim writes use the expected URLs and payloads', async () => {
  const calls = [], api = createApi({ baseUrl: '/', fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ site_id: 'site-a', deleted: true }); } });
  for (const method of ['getDeviation', 'getProgress', 'getImpact']) assert.equal((await api[method]('id/a')).siteId, 'site-a');
  assert.deepEqual(calls.map(call => call.url), ['/api/deviations/id%2Fa', '/api/site-progress/id%2Fa', '/api/cost-impacts/id%2Fa']);
  await api.createBooking({ workDayId: 'day-a', siteProgressItemId: 'spi-a', hours: 1.5 });
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { work_day_id: 'day-a', site_progress_item_id: 'spi-a', hours: 1.5 });
  await api.deleteBooking('booking/a'); assert.equal(calls.at(-1).url, '/api/time-bookings/booking%2Fa'); assert.equal(calls.at(-1).options.method, 'DELETE'); assert.equal(calls.at(-1).options.body, undefined);
  await api.createImpact({ siteId: 'site-a', title: 'Example', deviationIds: ['dev-a'], claimAmount: '0.10', settlementAmount: null });
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { site_id: 'site-a', title: 'Example', deviation_ids: ['dev-a'], claim_amount: '0.10', settlement_amount: null });
  await api.transitionImpact('impact-a', { to: 'notification_sent', result: 'settled' });
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { to: 'notification_sent' });
  await api.transitionImpact('impact-a', { to: 'closed', result: 'settled' });
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { to: 'closed', result: 'settled' });
  assert.equal(calls.at(-1).options.method, 'POST');
});
test('core API preserves unauthorized, forbidden and duplicate errors', async () => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'FORBIDDEN'], [409, 'TIME_BOOKING_DUPLICATE']]) {
    let unauthorized = 0;
    const api = createApi({ onUnauthorized: () => unauthorized++, fetchImpl: async () => Response.json({ code, error: 'Synthetic error' }, { status }) });
    await assert.rejects(api.deleteBooking('booking-a'), error => error.status === status && error.code === code);
    assert.equal(unauthorized, status === 401 ? 1 : 0);
  }
});
test('impact KPI totals use the filtered records with exact decimals and null counts', () => {
  const rows = [{ id: 'a', status: 'open', result: null, claimAmount: '9007199254740993.10', settlementAmount: null }, { id: 'b', status: 'open', result: null, claimAmount: '0.20', settlementAmount: '0.00' }, { id: 'c', status: 'closed', result: 'settled', claimAmount: '100', settlementAmount: '80' }];
  assert.deepEqual(impactTotals(filterSortRecords(rows, { status: 'open' })), { claimAmount: '9007199254740993.30', settlementAmount: '0.00', missingClaim: 0, missingSettlement: 1 });
  assert.deepEqual(impactTotals(filterSortRecords(rows, { result: 'settled' })), { claimAmount: '100', settlementAmount: '80', missingClaim: 0, missingSettlement: 0 });
});
test('impact KPI totals distinguish missing from zero and support negative and exponent values', () => {
  assert.deepEqual(impactTotals([]), { claimAmount: '0', settlementAmount: '0', missingClaim: 0, missingSettlement: 0 });
  assert.deepEqual(impactTotals([{ claimAmount: null, settlementAmount: null }]), { claimAmount: null, settlementAmount: null, missingClaim: 1, missingSettlement: 1 });
  assert.equal(impactTotals([{ claimAmount: 0.1 }, { claimAmount: 0.2 }, { claimAmount: '-0.30' }]).claimAmount, '0.00');
  assert.equal(impactTotals([{ claimAmount: 1e-7 }, { claimAmount: 1e21 }]).claimAmount, '1000000000000000000000.0000001');
});
test('booking grouping uses operational date, retains shifts, and sums employee by item rows', () => {
  const days = [{ id: 'night', operationalDate: '2026-03-28', employeeId: 'e2', shift: 'night' }, { id: 'day', operationalDate: '2026-03-28', employeeId: 'e1' }, { id: 'next', operationalDate: '2026-03-29', employeeId: 'e1' }];
  const employees = [{ id: 'e1', employeeNo: 'E-01' }, { id: 'e2', employeeNo: 'E-02' }], items = [{ id: 'spi', description: 'Example item' }];
  const bookings = [{ id: 'a', workDayId: 'night', siteProgressItemId: 'spi', hours: 1.5, createdAt: '2026-03-29T01:00:00Z' }, { id: 'b', workDayId: 'day', siteProgressItemId: 'spi', hours: 2 }, { id: 'c', workDayId: 'next', siteProgressItemId: 'spi', hours: 0 }];
  const before = structuredClone(bookings), groups = groupBookings(bookings, days, employees, items);
  assert.deepEqual(groups.map(group => [group.date, group.hours]), [['2026-03-29', 0], ['2026-03-28', 3.5]]);
  assert.deepEqual(groups[1].rows.map(row => row.id), ['b', 'a']); assert.equal(groups[1].rows[1].day.shift, 'night');
  assert.equal(groups[1].rows[1].item.description, 'Example item'); assert.deepEqual(bookings, before);
});
test('missing booking references remain visible without an invented date or employee', () => {
  const groups = groupBookings([{ id: 'orphan', workDayId: 'missing', siteProgressItemId: 'missing', hours: 3 }], [], [], []);
  assert.equal(groups[0].date, null); assert.equal(groups[0].hours, 3); assert.equal(groups[0].rows[0].employee, undefined);
  assert.deepEqual(groupBookings([], [], [], []), []);
});
test('list filtering combines fields and ordering is stable with nulls last in both directions', () => {
  const rows = [{ id: 'c', title: null, status: null, priority: 'high' }, { id: 'b', title: 'Item 10', status: 'open', priority: 'high', wbsId: 'w1' }, { id: 'a', title: 'Item 2', status: 'open', priority: 'normal', wbsId: 'w2' }, { id: 'd', title: 'Item 2', status: 'closed', priority: 'high' }];
  const before = structuredClone(rows);
  assert.deepEqual(filterSortRecords(rows).map(row => row.id), ['a', 'd', 'b', 'c']);
  assert.deepEqual(filterSortRecords(rows, {}, [{ key: 'title', descending: true }]).map(row => row.id), ['b', 'a', 'd', 'c']);
  assert.deepEqual(filterSortRecords(rows, { status: 'open', priority: 'high' }).map(row => row.id), ['b']);
  assert.deepEqual(filterSortRecords(rows, { status: null }).map(row => row.id), ['c']);
  assert.deepEqual(filterSortRecords(rows, { wbsId: 'w2' }).map(row => row.id), ['a']); assert.deepEqual(rows, before);
});
test('progress hours aggregate bookings without overwriting explicit API totals or null progress', () => {
  const items = [{ id: 'a', progressPct: null }, { id: 'b', bookedHours: 0 }, { id: 'c' }];
  const rows = progressWithHours(items, [{ siteProgressItemId: 'a', hours: 1.5 }, { siteProgressItemId: 'a', hours: 2 }, { siteProgressItemId: 'b', hours: 9 }]);
  assert.deepEqual(rows.map(row => row.bookedHours), [3.5, 0, 0]); assert.equal(rows[0].progressPct, null); assert.equal(items[0].bookedHours, undefined);
});
test('WBS flattening reuses tree records and handles empty leaf children', () => {
  const nodes = [{ id: 'a', children: [{ id: 'b', children: [] }, { id: 'c' }] }];
  const rows = flattenWbs(nodes); assert.deepEqual(rows.map(row => row.id), ['a', 'b', 'c']); assert.equal(rows[1], nodes[0].children[0]); assert.equal(nodes[0].children.length, 2);
});
test('core role permissions and claim transitions match the backend contract', () => {
  // A failed service worker registration must not paint a permanent banner while online.
  assert.deepEqual(offlineBannerState({ swUnavailable: true }), { visible: false, offline: false, storage: false, serviceWorker: false, pending: 0 });
  assert.deepEqual(offlineBannerState({ storageError: true, swUnavailable: true }), { visible: true, offline: false, storage: true, serviceWorker: false, pending: 0 });
  assert.deepEqual(offlineBannerState({ offline: true, swUnavailable: true }), { visible: true, offline: true, storage: false, serviceWorker: true, pending: 0 });
  assert.deepEqual(offlineBannerState({ pending: 2, swUnavailable: true }), { visible: true, offline: false, storage: false, serviceWorker: true, pending: 2 });
  assert.deepEqual(offlineBannerState({ pending: 1 }), { visible: true, offline: false, storage: false, serviceWorker: false, pending: 1 });
  assert.deepEqual(offlineBannerState({}), { visible: false, offline: false, storage: false, serviceWorker: false, pending: 0 });
  assert.deepEqual(corePermissions('owner'), { book: true, transition: true, steps: true, assign: true, tools: true, certifications: true, certificationWrite: true });
  assert.deepEqual(corePermissions('editor'), { book: true, transition: false, steps: true, assign: false, tools: true, certifications: true, certificationWrite: true });
  assert.deepEqual(corePermissions('verifier'), { book: false, transition: true, steps: false, assign: false, tools: true, certifications: true, certificationWrite: false });
  for (const role of ['viewer', undefined, 'unknown']) assert.deepEqual(corePermissions(role), { book: false, transition: false, steps: false, assign: false, tools: false, certifications: false, certificationWrite: false });
  assert.deepEqual(impactTransitions('open'), ['notification_sent', 'closed']); assert.deepEqual(impactTransitions('notification_sent'), ['submitted']);
  assert.deepEqual(impactTransitions('submitted'), ['closed']); assert.deepEqual(impactTransitions('closed'), []);
  impactTransitions('open').pop(); assert.equal(impactTransitions('open').length, 2);
});
test('new UI labels and workflow values are translated in both languages', () => {
  const keys = new Set([...Object.keys(messages.it), ...Object.keys(messages.en)]);
  for (const key of keys) if (key.startsWith('core') || ['deviations', 'progress', 'bookings', 'impacts'].some(prefix => key.startsWith(prefix)) || DEVIATION_STATUSES.includes(key) || IMPACT_RESULTS.includes(key)) {
    assert.equal(typeof messages.it[key], 'string', `Italian ${key}`); assert.equal(typeof messages.en[key], 'string', `English ${key}`);
  }
});

test('create actions are gated by role in the UI source', async () => {
  const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
  // Tasks: viewers must not see a create button the server would refuse.
  assert.match(source, /canWriteTask\(\) \? button\('newTask'/);
  // Sites: only an owner may create one.
  assert.match(source, /canCreateSite\(\) \? button\('newSite'/);
  assert.match(source, /const canWriteTask = \(\) => \['owner', 'editor', 'verifier'\]\.includes\(role\(\)\)/);
  assert.match(source, /const canCreateSite = \(\) => role\(\) === 'owner'/);
});

test('task classification is selectable, filterable and exported', async () => {
  const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
  assert.match(source, /id="filter-kind"/);
  assert.match(source, /\$\{field\('kind', 'kind', 'ordinary'/);
  assert.match(source, /taskKindLabelKey\(task\.kind \?\? 'ordinary'\)/);
  assert.match(source, /\(!filters\.kind \|\| \(task\.kind \?\? 'ordinary'\) === filters\.kind\)/);
  const domain = await readFile(new URL('../app/domain.mjs', import.meta.url), 'utf8');
  assert.match(domain, /TASK_KINDS = Object\.freeze\(\['ordinary', 'corrective'\]\)/);
});

test('light layout survives saved-view serialization and sanitization', () => {
  const payload = viewStatePayload({ layout: 'light', filters: { search: 'Synthetic', status: 'todo', person: 'Executor', priority: 'high' } });
  assert.equal(payload.layout, 'light');
  assert.deepEqual(sanitizeViewState(JSON.parse(JSON.stringify(payload))), payload);
  assert.equal(sanitizeViewState({ layout: 'unknown' }).layout, 'board');
});

test('light rows include only explicitly ordinary tasks without mutating input', () => {
  const tasks = [
    { id: 'corrective', kind: 'corrective', status: 'todo' },
    { id: 'ordinary', kind: 'ordinary', status: 'todo' },
    { id: 'missing', status: 'todo' },
    { id: 'null', kind: null, status: 'todo' },
    { id: 'unknown', kind: 'unknown', status: 'todo' },
  ];
  const before = structuredClone(tasks);
  const rows = lightTaskRows(tasks);
  assert.deepEqual(rows.map(row => row.id), ['ordinary']);
  assert.equal(rows[0], tasks[1]);
  assert.deepEqual(tasks, before);
  assert.deepEqual(lightTaskRows([]), []);
  assert.deepEqual(lightTaskRows([tasks[0]]), []);
});

test('light ordering puts every open status before closed, then due and title', () => {
  const row = (id, status, due, title = id) => ({ id, kind: 'ordinary', status, due, title });
  const tasks = [
    row('closed-early', 'closed', '2026-01-01'),
    row('missing', 'todo', null),
    row('late', 'blocked', '2026-02-03'),
    row('beta', 'in_progress', '2026-02-02', 'Beta'),
    row('alpha-b', 'to_verify', '2026-02-02', 'Alpha'),
    row('closed-late', 'closed', '2026-02-04'),
    row('alpha-a', 'todo', '2026-02-02', 'Alpha'),
    row('empty-due', 'todo', '', 'A'),
  ];
  assert.deepEqual(lightTaskRows(tasks).map(row => row.id),
    ['alpha-a', 'alpha-b', 'beta', 'late', 'empty-due', 'missing', 'closed-early', 'closed-late']);
});

test('light dialog decision collects required notes and reopening reasons', () => {
  assert.equal(transitionNeedsDialog(transitionRequirements({ kind: 'ordinary', status: 'to_verify' }, 'closed')), true);
  assert.equal(transitionNeedsDialog(transitionRequirements({ kind: 'ordinary', status: 'closed' }, 'todo')), true);
  assert.equal(transitionNeedsDialog({ note: true, reason: false }), true);
  assert.equal(transitionNeedsDialog({ note: false, reason: true }), true);
  assert.equal(transitionNeedsDialog({ note: false, reason: false }), false);
});

test('light view labels are available in Italian and English', () => {
  for (const key of ['light', 'lightClose', 'lightReopen', 'lightEmpty', 'lightAction']) {
    for (const language of ['it', 'en']) assert.equal(typeof messages[language][key], 'string', `${language}: ${key}`);
  }
  assert.equal(messages.it.light, 'Attività leggere');
  assert.equal(messages.it.lightClose, 'Chiudi');
  assert.equal(messages.it.lightReopen, 'Riapri');
});

// Exercise the actual renderers and command without loading the app's session,
// service worker or network bootstrap. Only DOM sinks and side effects are mocked.
async function lightUi(tasks, overrides = {}) {
  const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
  const nodes = { '#main': { innerHTML: '' }, '#task-results': { innerHTML: '' } };
  const dialogs = [], writes = [];
  const context = {
    state: { tasks }, siteId: 'site-a', taskView: 'light', view: 'tasks', actor: 'Synthetic reviewer', pendingOps: [],
    filters: { search: '', status: '', person: '', priority: '', kind: '' },
    siteTasks: () => tasks.filter(task => task.siteId === 'site-a'),
    $: selector => nodes[selector], t: key => messages.it[key] ?? key,
    canWriteTask: () => true, loadSavedViews() {}, renderSavedViews() {}, renderViewDirty() {},
    heading: () => '', taskListControls: () => '',
    personName: name => name || '—', dueMarkup: task => task.due || '—',
    badge: status => status, syncBadge: () => '',
    empty: title => messages.it[title],
    lightTaskRows, transitionNeedsDialog, transitionRequirements, allowedTransitions, transitionPayload,
    counts, STATUSES, PRIORITIES, TASK_KINDS, taskKindLabelKey,
    showModal: (title, html) => dialogs.push({ title, html }),
    field: (label, name, value, options) => `<textarea name="${name}" ${options.required ? 'required' : ''}></textarea>`,
    formActions: () => '',
    writeOperation: async (...args) => writes.push(args), toast() {}, errorMessage: error => error.message,
    ...overrides,
  };
  runInNewContext([
    section('const esc =', 'let session ='),
    section('const button =', 'function toast('),
    section('function filteredTasks()', 'const currentViewState ='),
    section('function renderTasks()', 'function taskCard('),
    section('const lightTransitions =', 'function renderDiary()'),
    section('function showTransition(', 'function showEntryForm()'),
  ].join('\n'), context);
  return { context, nodes, dialogs, writes };
}

test('light renderer shows six columns and ordinary rows while keeping shared filters', async () => {
  const task = { id: 'ordinary', siteId: 'site-a', kind: 'ordinary', status: 'to_verify', title: 'Synthetic ordinary', area: 'Area A', company: 'Company A', assignee: 'Executor A', priority: 'high' };
  const { context, nodes } = await lightUi([
    task,
    { ...task, id: 'corrective', kind: 'corrective', title: 'Synthetic corrective' },
    { ...task, id: 'other-site', siteId: 'site-b', title: 'Other site task' },
  ]);
  context.renderTasks();
  assert.equal((nodes['#main'].innerHTML.match(/data-command="task-view"/g) || []).length, 3);
  assert.match(nodes['#main'].innerHTML, /data-value="light" aria-pressed="true"/);
  const html = nodes['#task-results'].innerHTML;
  assert.equal((html.match(/<th scope="col">/g) || []).length, 6);
  assert.match(html, /Synthetic ordinary/);
  assert.doesNotMatch(html, /Synthetic corrective|Other site task/);
  assert.match(html, /data-command="light-transition"/);
  for (const [key, matching, missing] of [
    ['search', 'Company A', 'missing'], ['status', 'to_verify', 'closed'],
    ['person', 'Executor A', 'Other executor'], ['priority', 'high', 'normal'],
    ['kind', 'ordinary', 'corrective'],
  ]) {
    context.filters = { search: '', status: '', person: '', priority: '', kind: '', [key]: matching };
    context.renderTaskResults();
    assert.match(nodes['#task-results'].innerHTML, /Synthetic ordinary/, key);
    context.filters[key] = missing;
    context.renderTaskResults();
    assert.match(nodes['#task-results'].innerHTML, /Nessuna attività leggera/, key);
    assert.doesNotMatch(nodes['#task-results'].innerHTML, /<tbody>/, key);
  }
});

test('light close command opens the existing dialog with a required note and sends no write', async () => {
  const { context, dialogs, writes } = await lightUi([{ id: 'ordinary', kind: 'ordinary', status: 'to_verify' }]);
  await context.runLightTransition('ordinary');
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].html, /id="transition-form".*data-to="closed"/);
  assert.match(dialogs[0].html, /name="note" required/);
  assert.equal(writes.length, 0);
});

test('light command preserves existing transition, role, corrective and pending-operation guards', async () => {
  const task = { id: 'ordinary', kind: 'ordinary', status: 'to_verify' };
  for (const [candidate, overrides] of [
    [{ ...task, status: 'todo' }, {}], [{ ...task, status: 'closed' }, {}],
    [{ ...task, kind: 'corrective' }, {}], [task, { canWriteTask: () => false }],
    [task, { pendingOps: [{ entity_id: task.id, op_type: 'transition_task' }] }],
    [task, { pendingOps: [{ entity_id: task.id, op_type: 'create_task', status: 'failed' }] }],
  ]) {
    const { context, dialogs, writes } = await lightUi([candidate], overrides);
    await context.runLightTransition(candidate.id);
    assert.equal(dialogs.length, 0);
    assert.equal(writes.length, 0);
    if (overrides.canWriteTask) assert.equal(context.lightTaskButton(candidate), '—');
    else assert.match(context.lightTaskButton(candidate), /disabled/);
  }
});
