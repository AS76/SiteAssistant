import test from 'node:test';
import { operationalDate, shiftOf, crossesMidnight } from '../server/operational-day.mjs';

const options = { timeZone: 'Europe/Rome' };
const cases = [
  ['06:00 exact', '2026-11-08T05:00:00.000Z', '2026-11-08', 'day'],
  ['05:59', '2026-11-08T04:59:00.000Z', '2026-11-07', 'night'],
  ['last instant before cutoff', '2026-11-08T04:59:59.999Z', '2026-11-07', 'night'],
  ['23:00', '2026-11-08T22:00:00.000Z', '2026-11-08', 'night'],
  ['04:59', '2026-11-08T03:59:00.000Z', '2026-11-07', 'night'],
  ['18:00 exact', '2026-11-08T17:00:00.000Z', '2026-11-08', 'night'],
  ['midnight', '2026-11-07T23:00:00.000Z', '2026-11-07', 'night'],
  ['spring before jump, 01:59', '2026-03-29T00:59:00.000Z', '2026-03-28', 'night'],
  ['spring after jump, 03:00', '2026-03-29T01:00:00.000Z', '2026-03-28', 'night'],
  ['spring 05:59', '2026-03-29T03:59:00.000Z', '2026-03-28', 'night'],
  ['spring 06:00', '2026-03-29T04:00:00.000Z', '2026-03-29', 'day'],
  ['autumn first 02:30', '2026-10-25T00:30:00.000Z', '2026-10-24', 'night'],
  ['autumn second 02:30', '2026-10-25T01:30:00.000Z', '2026-10-24', 'night'],
  ['autumn 05:59', '2026-10-25T04:59:00.000Z', '2026-10-24', 'night'],
  ['autumn 06:00', '2026-10-25T05:00:00.000Z', '2026-10-25', 'day'],
  ['year boundary', '2025-12-31T23:30:00.000Z', '2025-12-31', 'night'],
  ['leap day', '2028-03-01T04:00:00.000Z', '2028-02-29', 'night'],
];

for (const [label, instant, date, shift] of cases) {
  test(`operational day and shift in Europe/Rome: ${label}`, t => {
    t.assert.strictEqual(operationalDate(instant, options), date);
    t.assert.strictEqual(shiftOf(instant, options), shift);
  });
}

test('operational day supports defaults, explicit zones and custom boundaries', t => {
  const instant = new Date('2026-11-08T05:00:00.000Z');
  t.assert.strictEqual(operationalDate(instant), '2026-11-08');
  t.assert.strictEqual(shiftOf(instant), 'day');
  t.assert.strictEqual(operationalDate(instant, { cutoff: '07:00' }), '2026-11-07');
  t.assert.strictEqual(operationalDate(instant, { timeZone: 'UTC' }), '2026-11-07');
  t.assert.strictEqual(shiftOf(instant, { dayStart: '07:00', nightStart: '19:00' }), 'night');
});

test('crossesMidnight compares HH:MM and includes equal times', t => {
  t.assert.strictEqual(crossesMidnight('23:00', '05:00'), true);
  t.assert.strictEqual(crossesMidnight('08:00', '17:00'), false);
  t.assert.strictEqual(crossesMidnight('06:00', '06:00'), true);
});

test('invalid instants, time zones and boundaries are rejected', t => {
  t.assert.throws(() => operationalDate('invalid'), { code: 'VALIDATION_ERROR' });
  t.assert.throws(() => operationalDate(0, { timeZone: 'Invalid/Zone' }), RangeError);
  for (const cutoff of ['6:00', '24:00', '06:60', '', null]) {
    t.assert.throws(() => operationalDate(0, { cutoff }), { code: 'VALIDATION_ERROR' });
  }
  t.assert.throws(() => shiftOf(0, { dayStart: 'invalid' }), { code: 'VALIDATION_ERROR' });
  t.assert.throws(() => crossesMidnight('08:00', 'invalid'), { code: 'VALIDATION_ERROR' });
});
