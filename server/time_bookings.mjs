import { requireModule } from './module-access.mjs';
import { randomUUID } from 'node:crypto';
import { RepositoryError, requireRole } from './repository.mjs';

const fail = (status, message, code) => { throw new RepositoryError(status, message, code); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idFields = ['id', 'site_id', 'work_day_id', 'site_progress_item_id', 'created_by'];
const publicBooking = row => ({ ...row, hours: Number(row.hours),
  ...Object.fromEntries(idFields.map(field => [field, row[field]?.toLowerCase() ?? null])) });

function validId(value, field) {
  if (typeof value !== 'string' || !uuid.test(value)) fail(400, `${field} must be a UUID.`, 'VALIDATION_ERROR');
  return value.toLowerCase();
}

function requireUser(user) {
  if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED');
}

async function timeBookingFilters(db, { siteId, siteProgressItemId, workDayId }, user) {
  requireUser(user);
  const site = validId(siteId, 'site_id'), clauses = ['site_id = ?'], values = [site];
  for (const [field, value] of [['site_progress_item_id', siteProgressItemId], ['work_day_id', workDayId]]) {
    if (value != null) { clauses.push(`${field} = ?`); values.push(validId(value, field)); }
  }
  await requireRole(db, site, user);
  await requireModule(db, site, user, 'bookings');
  return { where: clauses.join(' AND '), values };
}

export async function listTimeBookings(db, { limit = 50, offset = 0, ...filters } = {}, user) {
  const { where, values } = await timeBookingFilters(db, filters, user);
  return (await db.all(`SELECT * FROM time_bookings WHERE ${where}
    ORDER BY created_at, id LIMIT ? OFFSET ?`, ...values, limit, offset)).map(publicBooking);
}

export async function countTimeBookings(db, filters = {}, user) {
  const { where, values } = await timeBookingFilters(db, filters, user);
  return Number((await db.get(`SELECT COUNT(*) AS total FROM time_bookings WHERE ${where}`, ...values)).total);
}

export async function createTimeBooking(db, input, user) {
  requireUser(user);
  const workDayId = validId(input?.work_day_id, 'work_day_id');
  const itemId = validId(input?.site_progress_item_id, 'site_progress_item_id');
  const hours = input?.hours;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0) {
    fail(400, 'hours must be a finite non-negative number.', 'VALIDATION_ERROR');
  }
  const workDay = await db.get('SELECT site_id FROM work_days WHERE id = ?', workDayId);
  if (!workDay) fail(404, 'Work day not found.', 'WORK_DAY_NOT_FOUND');
  const item = await db.get('SELECT site_id FROM site_progress_items WHERE id = ?', itemId);
  if (!item) fail(404, 'Site progress item not found.', 'SITE_PROGRESS_ITEM_NOT_FOUND');
  if (workDay.site_id !== item.site_id) fail(409, 'Work day and progress item must belong to the same site.', 'TIME_BOOKING_SITE_MISMATCH');
  await requireRole(db, workDay.site_id, user, ['editor', 'owner']);
  await requireModule(db, workDay.site_id, user, 'bookings');
  try {
    // The database constraint arbitrates concurrent inserts on both drivers.
    const row = await db.get(`INSERT INTO time_bookings
      (id, site_id, work_day_id, site_progress_item_id, hours, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    randomUUID(), workDay.site_id, workDayId, itemId, hours, user.id, new Date().toISOString());
    return publicBooking(row);
  } catch (error) {
    if (db.isUniqueViolation(error)) fail(409, 'A booking already exists for this work day and progress item.', 'TIME_BOOKING_DUPLICATE');
    throw error;
  }
}

export async function deleteTimeBooking(db, id, user) {
  requireUser(user);
  const bookingId = validId(id, 'id');
  const row = await db.get('SELECT site_id FROM time_bookings WHERE id = ?', bookingId);
  if (!row) fail(404, 'Time booking not found.', 'TIME_BOOKING_NOT_FOUND');
  await requireRole(db, row.site_id, user, ['editor', 'owner']);
  await requireModule(db, row.site_id, user, 'bookings');
  await db.run('DELETE FROM time_bookings WHERE id = ?', bookingId);
  return { deleted: true };
}

export async function bookedHoursForItem(db, siteProgressItemId) {
  const id = validId(siteProgressItemId, 'site_progress_item_id');
  const row = await db.get('SELECT COALESCE(SUM(hours), 0) AS booked_hours FROM time_bookings WHERE site_progress_item_id = ?', id);
  return Number(row.booked_hours);
}
