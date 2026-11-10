import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { pipeline } from 'node:stream/promises';
import { S3Storage, ObjectStorageError, encodeS3Component } from './s3.mjs';
import { authenticate, login, memberships, publicUser, sessionCookie, isSecureRequest, createLoginLimiter } from './auth.mjs';
import { sendMail, MailNotConfiguredError, MailDeliveryError } from './auth-mail.mjs';
import { normalizeEmail, requestSignup, readSignupRequest, decideSignup, changePassword, forgotPassword, decisionPage } from './signup.mjs';
import { createTaskResponse } from './idempotency.mjs';
import { listWbs, getWbs, importWbs } from './wbs.mjs';
import { listSiteProgress, getSiteProgressItem, importSiteProgress } from './site-progress.mjs';
import { listEmployees, getEmployee, listWorkDays, importEmployees } from './hr.mjs';
import { listDeviations, getDeviation, importDeviations } from './deviations.mjs';
import { listTimeBookings, createTimeBooking, deleteTimeBooking, bookedHoursForItem } from './time_bookings.mjs';
import {
  RepositoryError, listSites, createSite, getSite, listTasks, getTask,
  transitionTask, listDiary, createDiary, requireRole, WRITE_ROLES, listMembers, setMember,
  createAttachment, listAttachments, getAttachment, deleteAttachment, MAX_ATTACHMENT_BYTES,
} from './repository.mjs';

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readJson(request, { includeHash = false, maxBytes = 65536 } = {}) {
  const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new RepositoryError(400, 'Content-Type must be application/json.', 'INVALID_JSON');
  }
  const decoder = new StringDecoder('utf8');
  const hash = createHash('sha256');
  let body = '';
  let size = 0;
  // Reject oversized input without accumulating the remainder in memory.
  let oversized = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) { oversized = true; body = ''; }
    if (!oversized) {
      hash.update(chunk);
      body += decoder.write(chunk);
    }
  }
  if (!oversized) body += decoder.end();
  if (oversized) throw new RepositoryError(maxBytes === 65536 ? 400 : 413, 'JSON body exceeds the size limit.', 'INVALID_JSON');
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    throw new RepositoryError(400, 'Malformed JSON body.', 'INVALID_JSON');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RepositoryError(400, 'Expected a JSON object.', 'INVALID_JSON');
  }
  return includeHash ? { input, requestHash: hash.digest('hex') } : input;
}

async function readForm(request) {
  const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') {
    throw new RepositoryError(400, 'Content-Type must be application/x-www-form-urlencoded.', 'INVALID_FORM');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= 4096) chunks.push(chunk);
    else chunks.length = 0;
  }
  if (size > 4096) throw new RepositoryError(400, 'Form body exceeds 4096 bytes.', 'INVALID_FORM');
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function html(response, status, message, review) {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(decisionPage(message, review));
}

// The caller owns the connection and closes it after the HTTP server stops.
export function createServer(db, { limiter = createLoginLimiter(), production = process.env.NODE_ENV === 'production',
  mailer = sendMail, ownerEmail = process.env.OWNER_EMAIL,
  publicUrl = process.env.PUBLIC_URL || 'https://api.siteassistant.asassi.cloud',
  requestLimiter = createLoginLimiter(), forgotLimiter = createLoginLimiter(), passwordLimiter = createLoginLimiter(),
  storage = new S3Storage(),
} = {}) {
  return createHttpServer(async (request, response) => {
    response.setHeader('Vary', 'Origin');
    response.setHeader('Cache-Control', 'no-store');
    if (request.headers.origin === 'https://siteassistant.asassi.cloud') {
      response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, Authorization, Cookie');
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    let isDecision = false;
    try {
      let url;
      try {
        url = new URL(request.url, 'http://127.0.0.1');
      } catch {
        throw new RepositoryError(400, 'Invalid request URL.', 'VALIDATION_ERROR');
      }
      const path = url.pathname;
      const method = request.method;
      isDecision = path === '/api/auth/request/decide' && ['GET', 'POST'].includes(method);
      if (isDecision) {
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
        if (method === 'GET') {
          const token = url.searchParams.get('token');
          const row = await readSignupRequest(db, token);
          return html(response, 200, 'Esamina la richiesta di accesso e scegli se approvarla o rifiutarla.', { email: row.email, requested_at: row.requested_at, token });
        }
        const form = await readForm(request);
        const decision = await decideSignup(db, form.get('token'), form.get('decision'), { mailer });
        return html(response, 200, decision === 'approve' ? 'Request approved. A temporary password has been emailed to the applicant.' : 'Request rejected. No account was created.');
      }
      if (['/api/auth/request', '/api/auth/forgot'].includes(path) && method === 'POST') {
        const email = normalizeEmail((await readJson(request)).email);
        const signup = path === '/api/auth/request';
        (signup ? requestLimiter : forgotLimiter).attempt(request.socket?.remoteAddress || '', email);
        // Preflight also covers no-op cases, keeping configuration errors uniform.
        if (signup && (typeof ownerEmail !== 'string' || !ownerEmail.trim())) throw new MailNotConfiguredError();
        mailer.assertConfigured?.();
        if (signup) await requestSignup(db, email, { mailer, ownerEmail, publicUrl });
        else await forgotPassword(db, email, { mailer });
        return json(response, 202, { status: 'accepted' });
      }
      if (path === '/api/health' && method === 'GET') return json(response, 200, { status: 'ok' });
      if (path === '/api/auth/login' && method === 'POST') {
        const result = await login(db, await readJson(request), {
          // Rate limiting uses the immediate peer, never X-Forwarded-For.
          ip: request.socket?.remoteAddress || '', userAgent: request.headers['user-agent'] || '', limiter,
        });
        response.setHeader('Set-Cookie', sessionCookie(result.token, { production, secure: isSecureRequest(request, { production }) }));
        return json(response, 200, { user: result.user });
      }
      const user = path.startsWith('/api/') ? await authenticate(db, request.headers.cookie) : null;
      if (path === '/api/auth/password' && method === 'POST') {
        passwordLimiter.attempt(request.socket?.remoteAddress || '', user.id);
        await changePassword(db, user, await readJson(request));
        return json(response, 200, { status: 'ok' });
      }
      if (path === '/api/auth/me' && method === 'GET') {
        return json(response, 200, { user: publicUser(user), roles: await memberships(db, user.id), password_change_required: Boolean(user.password_change_required) });
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        await db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', new Date().toISOString(), user.session_id);
        response.setHeader('Set-Cookie', sessionCookie('', { production, secure: isSecureRequest(request, { production }), clear: true }));
        return json(response, 200, { status: 'ok' });
      }
      if (['/api/employees', '/api/work-days'].includes(path) && method === 'GET') {
        const siteId = url.searchParams.get('site_id');
        if (!siteId) throw new RepositoryError(400, 'site_id is required.', 'VALIDATION_ERROR');
        await requireRole(db, siteId, user);
        const result = path === '/api/employees' ? await listEmployees(db, { siteId })
          : await listWorkDays(db, { siteId, employee_id: url.searchParams.get('employee_id'),
            from: url.searchParams.get('from'), to: url.searchParams.get('to') });
        return json(response, 200, result);
      }
      if (path === '/api/employees/import' && method === 'POST') {
        const input = await readJson(request);
        return json(response, 200, await importEmployees(db, input.site_id, user));
      }
      const employee = /^\/api\/employees\/([^/]+)$/.exec(path);
      if (employee && method === 'GET') {
        const record = await getEmployee(db, employee[1]);
        await requireRole(db, record.site_id, user);
        return json(response, 200, record);
      }
      if (path === '/api/wbs' && method === 'GET') {
        const siteId = url.searchParams.get('site_id');
        if (!siteId) throw new RepositoryError(400, 'site_id is required.', 'VALIDATION_ERROR');
        await requireRole(db, siteId, user);
        return json(response, 200, await listWbs(db, { siteId, flat: url.searchParams.get('flat') }));
      }
      if (path === '/api/wbs/import' && method === 'POST') {
        const input = await readJson(request);
        return json(response, 200, await importWbs(db, input.site_id, user));
      }
      const wbs = /^\/api\/wbs\/([^/]+)$/.exec(path);
      if (wbs && method === 'GET') {
        const node = await getWbs(db, wbs[1]);
        await requireRole(db, node.site_id, user);
        return json(response, 200, node);
      }
      if (path === '/api/site-progress' && method === 'GET') {
        const siteId = url.searchParams.get('site_id');
        if (!siteId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId)) {
          throw new RepositoryError(400, 'site_id must be a UUID.', 'VALIDATION_ERROR');
        }
        await requireRole(db, siteId.toLowerCase(), user);
        return json(response, 200, await listSiteProgress(db, { siteId, wbsId: url.searchParams.get('wbs_id') }));
      }
      if (path === '/api/site-progress/import' && method === 'POST') {
        const input = await readJson(request);
        return json(response, 200, await importSiteProgress(db, input.site_id, user));
      }
      const siteProgress = /^\/api\/site-progress\/([^/]+)$/.exec(path);
      if (siteProgress && method === 'GET') {
        const item = await getSiteProgressItem(db, siteProgress[1]);
        await requireRole(db, item.site_id, user);
        return json(response, 200, { ...item, booked_hours: await bookedHoursForItem(db, item.id) });
      }
      if (path === '/api/time-bookings' && method === 'GET') {
        return json(response, 200, await listTimeBookings(db, {
          siteId: url.searchParams.get('site_id'),
          siteProgressItemId: url.searchParams.get('site_progress_item_id'),
          workDayId: url.searchParams.get('work_day_id'),
        }, user));
      }
      if (path === '/api/time-bookings' && method === 'POST') {
        return json(response, 201, await createTimeBooking(db, await readJson(request), user));
      }
      const timeBooking = /^\/api\/time-bookings\/([^/]+)$/.exec(path);
      if (timeBooking && method === 'DELETE') {
        return json(response, 200, await deleteTimeBooking(db, timeBooking[1], user));
      }
      if (path === '/api/deviations' && method === 'GET') {
        const siteId = url.searchParams.get('site_id');
        if (!siteId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId)) {
          throw new RepositoryError(400, 'site_id must be a UUID.', 'VALIDATION_ERROR');
        }
        await requireRole(db, siteId.toLowerCase(), user);
        return json(response, 200, await listDeviations(db, { siteId,
          status: url.searchParams.get('status'), priority: url.searchParams.get('priority') }));
      }
      if (path === '/api/deviations/import' && method === 'POST') {
        const input = await readJson(request);
        return json(response, 200, await importDeviations(db, input.site_id, user));
      }
      const deviation = /^\/api\/deviations\/([^/]+)$/.exec(path);
      if (deviation && method === 'GET') {
        const record = await getDeviation(db, deviation[1]);
        await requireRole(db, record.site_id, user);
        return json(response, 200, record);
      }
      if (path === '/api/attachments' && method === 'POST') {
        const input = await readJson(request, { maxBytes: 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3) + 65536 });
        return json(response, 201, await createAttachment(db, input, user, storage));
      }
      if (path === '/api/attachments' && method === 'GET') {
        const input = {};
        for (const key of ['site_id', 'entity_type', 'entity_id']) {
          if (url.searchParams.has(key)) input[key] = url.searchParams.get(key);
        }
        return json(response, 200, await listAttachments(db, input, user));
      }
      const attachment = /^\/api\/attachments\/([^/]+)$/.exec(path);
      if (attachment && method === 'GET') {
        const file = await getAttachment(db, attachment[1], user, storage);
        if (response.destroyed) { file.stream.destroy(); return; }
        response.writeHead(200, {
          'Content-Type': file.mime, 'Content-Length': String(file.size),
          'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeS3Component(file.filename)}`,
          'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'",
        });
        await pipeline(file.stream, response);
        return;
      }
      if (attachment && method === 'DELETE') {
        await deleteAttachment(db, attachment[1], user, storage);
        response.writeHead(204);
        response.end();
        return;
      }
      if (path === '/api/sites' && method === 'GET') return json(response, 200, await listSites(db, user));
      if (path === '/api/sites' && method === 'POST') {
        const input = await readJson(request);
        const created = await db.transaction(async tx => {
          if (!await tx.get("SELECT site_id FROM site_members WHERE user_id = ? AND role = 'owner'", user.id)) {
            throw new RepositoryError(403, 'An owner role is required to create sites.', 'FORBIDDEN');
          }
          const created = await createSite(tx, input);
          await tx.run("INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, 'owner')", created.id, user.id);
          return created;
        });
        return json(response, 201, created);
      }
      const site = /^\/api\/sites\/([^/]+)$/.exec(path);
      if (site && method === 'GET') {
        await requireRole(db, site[1], user);
        return json(response, 200, await getSite(db, site[1]));
      }
      const members = /^\/api\/sites\/([^/]+)\/members$/.exec(path);
      if (members && method === 'GET') return json(response, 200, await listMembers(db, members[1], user));
      if (members && method === 'POST') return json(response, 200, await setMember(db, members[1], await readJson(request), user));
      if (path === '/api/tasks' && method === 'GET') {
        if (url.searchParams.get('siteId')) await requireRole(db, url.searchParams.get('siteId'), user);
        return json(response, 200, await listTasks(db, {
          siteId: url.searchParams.get('siteId'), status: url.searchParams.get('status'),
        }, user));
      }
      if (path === '/api/tasks' && method === 'POST') {
        const { input, requestHash } = await readJson(request, { includeHash: true });
        if (typeof input.siteId !== 'string' || !input.siteId.trim()) throw new RepositoryError(400, 'siteId is required.', 'VALIDATION_ERROR');
        await requireRole(db, input.siteId.trim(), user, WRITE_ROLES);
        const result = await createTaskResponse(db, { ...input, actor: user.name }, {
          key: request.headers['idempotency-key'],
          requestHash: createHash('sha256').update(user.id).update(requestHash).digest('hex'),
        });
        return json(response, result.status, result.body);
      }
      const task = /^\/api\/tasks\/([^/]+)$/.exec(path);
      if (task && method === 'GET') {
        const record = await getTask(db, task[1]);
        await requireRole(db, record.site_id, user);
        return json(response, 200, record);
      }
      const transition = /^\/api\/tasks\/([^/]+)\/transition$/.exec(path);
      if (transition && method === 'POST') {
        return json(response, 200, await transitionTask(db, transition[1], await readJson(request), user));
      }
      if (path === '/api/diary' && method === 'GET') {
        if (url.searchParams.get('siteId')) await requireRole(db, url.searchParams.get('siteId'), user);
        return json(response, 200, await listDiary(db, { siteId: url.searchParams.get('siteId') }, user));
      }
      if (path === '/api/diary' && method === 'POST') {
        const input = await readJson(request);
        if (typeof input.siteId !== 'string' || !input.siteId.trim()) throw new RepositoryError(400, 'siteId is required.', 'VALIDATION_ERROR');
        await requireRole(db, input.siteId.trim(), user, WRITE_ROLES);
        return json(response, 201, await createDiary(db, input));
      }
      json(response, 404, { error: 'Route not found.', code: 'NOT_FOUND' });
    } catch (error) {
      // A failed/aborted download must not append JSON to a binary response.
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      if (error instanceof ObjectStorageError) {
        return json(response, error.status, { error: error.message, code: error.code });
      }
      if (error instanceof MailNotConfiguredError || error instanceof MailDeliveryError) {
        return json(response, 503, { error: error.message, code: error.code });
      }
      if (isDecision && error instanceof RepositoryError && error.code !== 'INVALID_FORM') return html(response, error.status, error.message);
      if (error instanceof RepositoryError) {
        if (error.retryAfter) response.setHeader('Retry-After', String(error.retryAfter));
        json(response, error.status, { error: error.message, code: error.code });
      } else {
        console.error('Backend request failed.');
        json(response, 500, { error: 'Internal server error.', code: 'INTERNAL_ERROR' });
      }
    }
  });
}
