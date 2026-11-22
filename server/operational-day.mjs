function time(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw Object.assign(new RangeError('Time must be a valid HH:MM value.'), { code: 'VALIDATION_ERROR' });
  }
  return value;
}

function localFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, calendar: 'iso8601', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
}

function localParts(instant, formatter) {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) {
    throw Object.assign(new RangeError('Invalid instant.'), { code: 'VALIDATION_ERROR' });
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return { date: `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function calendarDateFormatter(timeZone) {
  const formatter = localFormatter(timeZone);
  return instant => localParts(instant, formatter).date;
}

export function calendarDayAge(eventDay, today) {
  return (Date.parse(today) - Date.parse(eventDay)) / 86_400_000;
}

export function operationalDate(instant, { timeZone = 'Europe/Rome', cutoff = '06:00', dayStart = cutoff } = {}) {
  time(dayStart);
  const local = localParts(instant, localFormatter(timeZone));
  if (local.time >= dayStart) return local.date;
  // Subtract a calendar day, not 24 hours from the instant: DST days vary in length.
  const previous = new Date(`${local.date}T12:00:00.000Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

export function shiftOf(instant, { timeZone = 'Europe/Rome', dayStart = '06:00', nightStart = '18:00' } = {}) {
  return shiftForLocalTime(localParts(instant, localFormatter(timeZone)).time, { dayStart, nightStart });
}

export function shiftForLocalTime(clock, { dayStart = '06:00', nightStart = '18:00' } = {}) {
  time(clock);
  time(dayStart);
  time(nightStart);
  const day = dayStart <= nightStart
    ? clock >= dayStart && clock < nightStart
    : clock >= dayStart || clock < nightStart;
  return day ? 'day' : 'night';
}

export function crossesMidnight(startHHMM, endHHMM) {
  return time(endHHMM) <= time(startHHMM);
}
