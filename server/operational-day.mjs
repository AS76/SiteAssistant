function time(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw Object.assign(new RangeError('Time must be a valid HH:MM value.'), { code: 'VALIDATION_ERROR' });
  }
  return value;
}

function localParts(instant, timeZone) {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) {
    throw Object.assign(new RangeError('Invalid instant.'), { code: 'VALIDATION_ERROR' });
  }
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone, calendar: 'iso8601', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function operationalDate(instant, { timeZone = 'Europe/Rome', cutoff = '06:00' } = {}) {
  time(cutoff);
  const local = localParts(instant, timeZone);
  if (local.time >= cutoff) return local.date;
  // Subtract a calendar day, not 24 hours from the instant: DST days vary in length.
  const previous = new Date(`${local.date}T12:00:00.000Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

export function shiftOf(instant, { timeZone = 'Europe/Rome', dayStart = '06:00', nightStart = '18:00' } = {}) {
  time(dayStart);
  time(nightStart);
  const local = localParts(instant, timeZone).time;
  const day = dayStart <= nightStart
    ? local >= dayStart && local < nightStart
    : local >= dayStart || local < nightStart;
  return day ? 'day' : 'night';
}

export function crossesMidnight(startHHMM, endHHMM) {
  return time(endHHMM) <= time(startHHMM);
}
