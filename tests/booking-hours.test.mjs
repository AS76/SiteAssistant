import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { groupBookings, weeklyBookingHours, filterSortRecords } from '../app/domain.mjs';
import { messages } from '../app/i18n.mjs';
import { DASHBOARD_WIDGETS } from '../app/dashboard-layout.mjs';

const employees = [{ id: 'employee-a', employeeNo: 'SYN-001' }];
const day = { id: 'day-a', employeeId: 'employee-a', operationalDate: '2026-01-05', workTime: '8', bookedHours: '3', openHours: '5' };
const booking = { id: 'booking-a', workDayId: 'day-a', siteProgressItemId: 'item-a', hours: 2 };
const group = (days = [day], bookings = [booking]) => groupBookings(bookings, days, employees, [])[0];

test('daily source facts stay separate from the app sum and variance can have either sign', () => {
  const bookings = [booking, { ...booking, id: 'booking-b', siteProgressItemId: 'item-b', hours: 1.5 }];
  const result = group([day], bookings);
  assert.equal(result.sourceWorkTime, 8);
  assert.equal(result.sourceBookedHours, 3);
  assert.equal(result.sourceOpenHours, 5);
  assert.equal(result.appBookedHours, 3.5);
  assert.equal(result.variance, 1.5);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.rows.map(row => row.hours), [2, 1.5]);
  const overbooked = group([day], [{ ...booking, hours: 7 }]);
  assert.equal(overbooked.variance, -2);
  assert.equal(overbooked.appBookedHours, 7);
  assert.equal(overbooked.sourceBookedHours, 3);
});

test('null and absent source values remain null and list the missing aggregate fields', () => {
  const result = group([{ ...day, workTime: null, bookedHours: undefined, openHours: null }]);
  assert.equal(result.sourceWorkTime, null);
  assert.equal(result.sourceBookedHours, null);
  assert.equal(result.sourceOpenHours, null);
  assert.equal(result.appBookedHours, 2);
  assert.equal(result.variance, null);
  assert.deepEqual(result.missing, ['sourceWorkTime', 'sourceBookedHours', 'sourceOpenHours']);
  assert.equal(group([{ ...day, bookedHours: null }]).variance, null);
  const withoutOpen = group([{ ...day, openHours: null }]);
  assert.equal(withoutOpen.variance, 3);
  assert.deepEqual(withoutOpen.missing, ['sourceOpenHours']);
});

test('days without app bookings are visible and explicit source zeroes are known facts', () => {
  const result = group([day], []);
  assert.equal(result.appBookedHours, 0);
  assert.equal(result.variance, 5);
  assert.deepEqual(result.rows, []);
  const zero = group([{ ...day, workTime: 0, bookedHours: '0', openHours: 0 }], []);
  assert.equal(zero.sourceWorkTime, 0);
  assert.equal(zero.sourceBookedHours, 0);
  assert.equal(zero.sourceOpenHours, 0);
  assert.equal(zero.variance, 0);
  assert.deepEqual(zero.missing, []);
});

test('same employee shifts merge per operational date and count each source fact once', () => {
  const days = [day, { ...day, id: 'night', shift: 'night', workTime: 4, bookedHours: 1, openHours: 3 }];
  const bookings = [booking, { ...booking, id: 'booking-b', workDayId: 'night', hours: 3 }];
  const before = structuredClone({ days, bookings, employees });
  const result = group(days, bookings);
  assert.equal(result.workDays.length, 2);
  assert.equal(result.sourceWorkTime, 12);
  assert.equal(result.sourceBookedHours, 4);
  assert.equal(result.sourceOpenHours, 8);
  assert.equal(result.appBookedHours, 5);
  assert.equal(result.variance, 3);
  assert.equal(result.rows[1].day.shift, 'night');
  assert.deepEqual({ days, bookings, employees }, before);
  const partial = group([day, { ...days[1], workTime: null }], bookings);
  assert.equal(partial.sourceWorkTime, null);
  assert.equal(partial.variance, null);
});

test('different employees, dates and unresolved work days never share a group', () => {
  const days = [day, { ...day, id: 'other', employeeId: 'employee-b' }, { ...day, id: 'next', operationalDate: '2026-01-06' }];
  const groups = groupBookings([booking], days, [...employees, { id: 'employee-b', employeeNo: 'SYN-002' }], []);
  assert.deepEqual(groups.map(row => [row.date, row.employeeId, row.appBookedHours]), [
    ['2026-01-06', 'employee-a', 0], ['2026-01-05', 'employee-a', 2], ['2026-01-05', 'employee-b', 0],
  ]);
  const orphans = groupBookings([{ ...booking, workDayId: 'missing-a' }, { ...booking, id: 'orphan-b', workDayId: 'missing-b' }], [], [], []);
  assert.equal(orphans.length, 2);
  for (const row of orphans) {
    assert.equal(row.date, null);
    assert.equal(row.employeeId, null);
    assert.equal(row.sourceWorkTime, null);
    assert.equal(row.variance, null);
  }
});

test('decimal hour arithmetic does not invent a signed variance for a balanced day', () => {
  const result = group([{ ...day, workTime: '0.6', bookedHours: '0.3', openHours: '0.3' }], [
    { ...booking, hours: 0.1 }, { ...booking, id: 'booking-b', hours: 0.2 },
  ]);
  assert.equal(result.appBookedHours, 0.3);
  assert.equal(result.variance, 0);
});

test('weekly source worked hours use operational Monday and remain separate from app totals', () => {
  const bookedWeeks = [{ week: '2025-12-29', hours: 2 }, { week: '2026-01-05', hours: 4 }];
  const days = [{ ...day, operationalDate: '2026-01-04' }, day, { ...day, id: 'later', operationalDate: '2026-01-11', workTime: 4 }];
  const before = structuredClone({ bookedWeeks, days });
  assert.deepEqual(weeklyBookingHours(bookedWeeks, days), [
    { week: '2025-12-29', appBookedHours: 2, sourceWorkTime: 8 },
    { week: '2026-01-05', appBookedHours: 4, sourceWorkTime: 12 },
  ]);
  assert.deepEqual({ bookedWeeks, days }, before);
});

test('weekly worked totals preserve missing values and include weeks without app bookings', () => {
  assert.deepEqual(weeklyBookingHours([{ week: '2026-01-05', hours: 2 }], []), [
    { week: '2026-01-05', appBookedHours: 2, sourceWorkTime: null },
  ]);
  assert.deepEqual(weeklyBookingHours([], [day]), [
    { week: '2026-01-05', appBookedHours: 0, sourceWorkTime: 8 },
  ]);
  assert.equal(weeklyBookingHours([], [day, { ...day, id: 'unknown', workTime: null }])[0].sourceWorkTime, null);
  assert.deepEqual(weeklyBookingHours([], [{ ...day, operationalDate: null }]), []);
  assert.equal(weeklyBookingHours([], [{ ...day, workTime: 0 }])[0].sourceWorkTime, 0);
});

test('weekly overview keeps the last six weeks in chronological order', () => {
  const days = Array.from({ length: 8 }, (_, i) => ({ ...day, operationalDate: `2026-01-${String(1 + i * 4).padStart(2, '0')}` }));
  const weeks = Array.from({ length: 8 }, (_, i) => ({ week: `2025-11-${String(1 + i * 3).padStart(2, '0')}`, hours: i }));
  const rows = weeklyBookingHours(weeks, days);
  assert.equal(rows.length, 6);
  assert.equal(rows.at(-1).week, '2026-01-26');
  assert.deepEqual(rows.map(row => row.week), rows.map(row => row.week).sort());
});

// Execute the real renderers with synthetic data and DOM sinks, without bootstrap or sockets.
async function ui({ days = [day], bookings = [booking], language = 'it', canBook = false } = {}) {
  const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
  const context = {
    language, t: key => {
      assert.equal(typeof messages[language][key], 'string', `translation: ${key}`);
      return messages[language][key];
    },
    coreData: name => ({ workDays: days, bookings, employees, progress: [{ id: 'item-a', description: '<b>Synthetic item</b>' }] })[name],
    coreFilters: { bookings: { date: '' } }, permissions: () => ({ book: canBook }),
    dateLabel: date => date, empty: key => messages[language][key],
    groupBookings, weeklyBookingHours, filterSortRecords, DASHBOARD_WIDGETS,
    localOverviewWidgets: () => ({}), money: value => String(value), earnedValueSummary: () => '',
    donut: () => '', sectionBars: () => '',
  };
  runInNewContext([
    section('const esc =', 'let session ='), section('const button =', 'function toast('),
    section('const coreValue =', 'const coreDetailButton ='),
    section('function renderBookings()', 'function renderTools()'),
    section('function renderOverviewWidgets(', 'async function readOverviewLayout('),
  ].join('\n'), context);
  return context;
}

test('booking renderer labels every source, keeps details internal and explains signed variance in IT/EN', async () => {
  for (const language of ['it', 'en']) {
    const context = await ui({ language, canBook: true });
    const html = context.renderBookings();
    for (const key of ['coreSourceWorkTime', 'coreSourceBookedHours', 'coreAppBookedHours', 'coreSourceOpenHours', 'coreVariance', 'coreHoursLegendSource', 'coreHoursLegendApp']) {
      assert.ok(html.includes(messages[language][key]), key);
    }
    assert.match(html, /booking-legend.*<br>/);
    assert.match(html, /booking-variance-positive.*\+3/);
    assert.match(html, /&lt;b&gt;Synthetic item&lt;\/b&gt;/);
    assert.match(html, /data-command="booking-delete"/);
    assert.equal((html.match(/<input /g) || []).length, 1, 'only app booking hours are editable');
    const negative = await ui({ language, bookings: [{ ...booking, hours: 7 }] });
    assert.match(negative.renderBookings(), /booking-variance-negative.*-2/);
    assert.ok(negative.renderBookings().includes(messages[language].coreVarianceNegative));
  }
});

test('booking renderer shows unbooked days, unknown source values and a non-calculable variance', async () => {
  const context = await ui({ days: [{ ...day, workTime: null }], bookings: [] });
  const html = context.renderBookings();
  assert.match(html, /SYN-001/);
  assert.ok(html.includes(messages.it.coreNotCalculable));
  assert.ok(html.includes(messages.it.coreUnknown));
  assert.doesNotMatch(html, /booking-variance-zero|booking-delete/);
  const balanced = await ui({ bookings: [{ ...booking, hours: 5 }] });
  assert.match(balanced.renderBookings(), /booking-variance-zero.*\+0/);
  context.coreFilters.bookings.date = '2026-01-06';
  assert.doesNotMatch(context.renderBookings(), /class="core-day"/);
});

test('overview renderer shows weekly app and worked hours separately, including known zero', async () => {
  const context = await ui(), target = {};
  const data = { deviations: [], progress: [], claims: { open: 0, settled: 0 }, hours: [{ week: '2026-01-05', hours: 2 }], workDays: [day] };
  context.renderOverviewWidgets(target, ['kpi_booked_hours', 'hours_by_week'], data);
  assert.match(target.innerHTML, /Ore prenotate in app: 2/);
  assert.match(target.innerHTML, /Ore lavorate \(sorgente\): 8/);
  assert.doesNotMatch(target.innerHTML, /(?:app|sorgente)\): 10/);
  context.renderOverviewWidgets(target, ['hours_by_week'], { ...data, workDays: [{ ...day, workTime: null }] });
  assert.doesNotMatch(target.innerHTML, /Ore lavorate/);
  context.renderOverviewWidgets(target, ['hours_by_week'], { ...data, workDays: [{ ...day, workTime: 0 }] });
  assert.match(target.innerHTML, /Ore lavorate \(sorgente\): 0/);
});

async function overviewLoader(freshApi) {
  const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
  const renders = [], target = { setAttribute() {} };
  const context = {
    freshApi, siteId: 'site-a', session: { user: { id: 'synthetic-user' } }, view: 'overview',
    $: () => target, document: { body: { contains: () => true } }, overviewCache: new Map(),
    readOverviewLayout: async () => ({ widgets: ['hours_by_week'] }),
    renderOverviewWidgets: (_target, _widgets, data, failed) => renders.push({ data, failed }),
  };
  runInNewContext(source.slice(source.indexOf('async function loadOverviewDashboard()'), source.indexOf('async function showDashboardLayoutForm()')), context);
  return { context, renders };
}

test('overview loads source work days through the existing site-scoped API and caches them with figures', async () => {
  const calls = [], data = { hours: [{ week: '2026-01-05', hours: 2 }] }, before = structuredClone(data);
  const { context, renders } = await overviewLoader({
    dashboard: async site => { calls.push(['dashboard', site]); return data; },
    listWorkDays: async filters => { calls.push(['workDays', filters.siteId]); return [day]; },
  });
  await context.loadOverviewDashboard();
  assert.deepEqual(calls, [['dashboard', 'site-a'], ['workDays', 'site-a']]);
  assert.deepEqual(renders.at(-1).data.workDays, [day]);
  assert.equal(renders.at(-1).failed, false);
  assert.deepEqual(data, before, 'wire response is not changed');
  await context.loadOverviewDashboard();
  assert.equal(calls.length, 2, 'both resources share the existing overview cache');
});

test('a source read failure leaves app figures available and late results cannot render on another site', async () => {
  const { context, renders } = await overviewLoader({
    dashboard: async () => ({ hours: [] }),
    listWorkDays: async () => { throw new Error('Synthetic unavailable read'); },
  });
  await context.loadOverviewDashboard();
  assert.equal(renders.at(-1).data.workDays.length, 0);
  assert.equal(renders.at(-1).failed, false);
  context.overviewCache.clear();
  let resolveRead;
  context.freshApi.listWorkDays = () => new Promise(resolve => { resolveRead = resolve; });
  const loading = context.loadOverviewDashboard();
  context.siteId = 'site-b';
  resolveRead([day]);
  const count = renders.length;
  await loading;
  assert.equal(renders.length, count);
  assert.equal(context.overviewCache.size, 0);
});

test('booking loading includes later pages in app totals and never returns a partial result on failure', async () => {
  const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
  const bookings = Array.from({ length: 201 }, (_, i) => ({ ...booking, id: `booking-${i}`, hours: 0.5 }));
  const calls = [], context = { freshApi: { listBookings: async filters => {
    calls.push([filters.siteId, filters.limit, filters.offset]);
    return bookings.slice(filters.offset, filters.offset + filters.limit);
  } } };
  runInNewContext(source.slice(source.indexOf('async function loadBookingRows('), source.indexOf('function coreResource(')), context);
  const rows = await context.loadBookingRows('site-a');
  assert.deepEqual(calls, [['site-a', 200, 0], ['site-a', 200, 200]]);
  assert.equal(rows.length, 201);
  assert.equal(group([day], rows).appBookedHours, 100.5);
  assert.equal(group([day], rows).variance, -95.5);
  context.freshApi.listBookings = async ({ offset }) => {
    if (offset) throw new Error('Synthetic unavailable page');
    return bookings.slice(0, 200);
  };
  await assert.rejects(context.loadBookingRows('site-a'), /Synthetic unavailable page/);
});
