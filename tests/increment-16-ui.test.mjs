import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, deviationFromApi, progressFromApi, bookingFromApi, impactFromApi } from '../app/api.mjs';
import { offlineBannerState, DEVIATION_STATUSES, IMPACT_RESULTS, impactTransitions, corePermissions, filterSortRecords, impactTotals, groupBookings, progressWithHours, flattenWbs } from '../app/domain.mjs';
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
  assert.deepEqual(calls.map(call => call.url), ['/api/deviations', '/api/site-progress', '/api/time-bookings', '/api/cost-impacts', '/api/work-days', '/api/employees'].map(path => `${path}?site_id=site-a`));
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
  assert.deepEqual(corePermissions('owner'), { book: true, transition: true, steps: true, assign: true });
  assert.deepEqual(corePermissions('editor'), { book: true, transition: false, steps: true, assign: false });
  assert.deepEqual(corePermissions('verifier'), { book: false, transition: true, steps: false, assign: false });
  for (const role of ['viewer', undefined, 'unknown']) assert.deepEqual(corePermissions(role), { book: false, transition: false, steps: false, assign: false });
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
