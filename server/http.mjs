import { createServer as createHttpServer } from 'node:http';
import {
  RepositoryError, listSites, createSite, getSite, listTasks, createTask, getTask,
  transitionTask, listDiary, createDiary,
} from './repository.mjs';

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new RepositoryError(400, 'Content-Type must be application/json.', 'INVALID_JSON');
  }
  request.setEncoding('utf8');
  let body = '';
  // Reject oversized input without accumulating the remainder in memory.
  let oversized = false;
  for await (const chunk of request) {
    if (!oversized) body += chunk;
    if (body.length > 65536) { oversized = true; body = ''; }
  }
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
  return input;
}

// The caller owns the connection and closes it after the HTTP server stops.
export function createServer(db) {
  return createHttpServer(async (request, response) => {
    try {
      let url;
      try {
        url = new URL(request.url, 'http://127.0.0.1');
      } catch {
        throw new RepositoryError(400, 'Invalid request URL.', 'VALIDATION_ERROR');
      }
      const path = url.pathname;
      const method = request.method;
      if (path === '/api/sites' && method === 'GET') return json(response, 200, await listSites(db));
      if (path === '/api/sites' && method === 'POST') {
        return json(response, 201, await createSite(db, await readJson(request)));
      }
      const site = /^\/api\/sites\/([^/]+)$/.exec(path);
      if (site && method === 'GET') return json(response, 200, await getSite(db, site[1]));
      if (path === '/api/tasks' && method === 'GET') {
        return json(response, 200, await listTasks(db, {
          siteId: url.searchParams.get('siteId'), status: url.searchParams.get('status'),
        }));
      }
      if (path === '/api/tasks' && method === 'POST') {
        return json(response, 201, await createTask(db, await readJson(request)));
      }
      const task = /^\/api\/tasks\/([^/]+)$/.exec(path);
      if (task && method === 'GET') return json(response, 200, await getTask(db, task[1]));
      const transition = /^\/api\/tasks\/([^/]+)\/transition$/.exec(path);
      if (transition && method === 'POST') {
        return json(response, 200, await transitionTask(db, transition[1], await readJson(request)));
      }
      if (path === '/api/diary' && method === 'GET') {
        return json(response, 200, await listDiary(db, { siteId: url.searchParams.get('siteId') }));
      }
      if (path === '/api/diary' && method === 'POST') {
        return json(response, 201, await createDiary(db, await readJson(request)));
      }
      json(response, 404, { error: 'Route not found.', code: 'NOT_FOUND' });
    } catch (error) {
      if (error instanceof RepositoryError) {
        json(response, error.status, { error: error.message, code: error.code });
      } else {
        console.error('Backend request failed:', error);
        json(response, 500, { error: 'Internal server error.', code: 'INTERNAL_ERROR' });
      }
    }
  });
}
