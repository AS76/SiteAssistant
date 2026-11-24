import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticHandler } from '../server/static-dev.mjs';
import { createServer as createApplication } from '../server/http.mjs';
import { openTestDb } from './helpers/db.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'static-dev-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>shell</title>');
  await writeFile(join(root, 'app.mjs'), 'export const ok = true;\n');
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'file.json'), '{"ok":true}');
  await writeFile(join(root, '..', 'secret-probe.txt'), 'outside').catch(() => {});
  const serve = createStaticHandler(root);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (await serve(request, response, url)) return;
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end('{"code":"NOT_FOUND"}');
  });
  t.after(async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('dev static handler serves the shell, types files and refuses escapes', async t => {
  const base = await fixture(t);
  const root = await fetch(base + '/');
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type'), /text\/html/);
  assert.match(await root.text(), /shell/);

  const script = await fetch(base + '/app.mjs');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /text\/javascript/);
  assert.match(script.headers.get('cache-control'), /no-cache/);

  const nested = await fetch(base + '/nested/file.json');
  assert.equal(nested.status, 200);
  assert.deepEqual(await nested.json(), { ok: true });

  const head = await fetch(base + '/app.mjs', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const missing = await fetch(base + '/nope.css');
  assert.equal(missing.status, 404);

  // A traversal attempt must never reach a file outside the served directory.
  for (const path of ['/%2e%2e/secret-probe.txt', '/..%2fsecret-probe.txt']) {
    const response = await fetch(base + path);
    assert.notEqual(response.status, 200, path);
    assert.doesNotMatch(await response.text(), /outside/, path);
  }

  const post = await fetch(base + '/', { method: 'POST' });
  assert.equal(post.status, 404);
});

test('API errors, preflight and PWA assets carry the global security headers', async t => {
  const { db, close } = await openTestDb(); t.after(close);
  const server = createApplication(db, { production: false, staticDir: new URL('../app/', import.meta.url).pathname });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [path, method, status] of [['/', 'GET', 200], ['/sw.js', 'GET', 200], ['/manifest.webmanifest', 'HEAD', 200],
    ['/api/health', 'GET', 200], ['/api/sites', 'GET', 401], ['/api/sites', 'OPTIONS', 204], ['/missing.css', 'GET', 404]]) {
    const response = await fetch(base + path, { method, headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(response.status, status, path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000', path);
    const policy = response.headers.get('content-security-policy');
    for (const directive of ["script-src 'self'", "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "frame-ancestors 'none'"]) {
      assert.ok(policy.includes(directive), path);
    }
    await response.arrayBuffer();
  }
  const insecure = await fetch(base + '/api/health');
  assert.equal(insecure.headers.get('strict-transport-security'), null);
});
