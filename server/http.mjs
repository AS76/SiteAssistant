import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { authenticate, login, memberships, publicUser, sessionCookie, isSecureRequest, createLoginLimiter } from './auth.mjs';
import { createTaskResponse } from './idempotency.mjs';
import {
  RepositoryError, listSites, createSite, getSite, listTasks, getTask,
  transitionTask, listDiary, createDiary, requireRole, WRITE_ROLES, listMembers, setMember,
} from './repository.mjs';

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readJson(request, { includeHash = false } = {}) {
  const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new RepositoryError(400, 'Content-Type must be application/json.', 'INVALID_JSON');
  }
  const decoder = new StringDecoder('utf8');
  const hash = createHash('sha256');
  let body = '';
  // Reject oversized input without accumulating the remainder in memory.
  let oversized = false;
  for await (const chunk of request) {
    if (!oversized) {
      hash.update(chunk);
      body += decoder.write(chunk);
    }
    if (body.length > 65536) { oversized = true; body = ''; }
  }
  if (!oversized) body += decoder.end();
  if (body.length > 65536) oversized = true;
  if (oversized) throw new RepositoryError(400, 'JSON body exceeds 65536 characters.', 'INVALID_JSON');
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

// The caller owns the connection and closes it after the HTTP server stops.
export function createServer(db, { limiter = createLoginLimiter(), production = process.env.NODE_ENV === 'production' } = {}) {
  return createHttpServer(async (request, response) => {
    response.setHeader('Vary', 'Origin');
    response.setHeader('Cache-Control', 'no-store');
    if (request.headers.origin === 'https://siteassistant.asassi.cloud') {
      response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, Authorization, Cookie');
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    try {
      let url;
      try {
        url = new URL(request.url, 'http://127.0.0.1');
      } catch {
        throw new RepositoryError(400, 'Invalid request URL.', 'VALIDATION_ERROR');
      }
      const path = url.pathname;
      const method = request.method;
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
      if (path === '/api/auth/me' && method === 'GET') {
        return json(response, 200, { user: publicUser(user), roles: await memberships(db, user.id) });
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        await db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', new Date().toISOString(), user.session_id);
        response.setHeader('Set-Cookie', sessionCookie('', { production, secure: isSecureRequest(request, { production }), clear: true }));
        return json(response, 200, { status: 'ok' });
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
      if (error instanceof RepositoryError) {
        if (error.retryAfter) response.setHeader('Retry-After', String(error.retryAfter));
        json(response, error.status, { error: error.message, code: error.code });
      } else {
        console.error('Backend request failed:', error);
        json(response, 500, { error: 'Internal server error.', code: 'INTERNAL_ERROR' });
      }
    }
  });
}
