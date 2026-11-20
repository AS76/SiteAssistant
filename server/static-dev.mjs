import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

// Development-only static host: the API and the browser client share one origin, so a fresh
// clone runs with `npm run dev` and no CORS exception. Never enabled in production, where a
// reverse proxy serves the same files.
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

export function createStaticHandler(root) {
  // Normalise away a trailing separator so the prefix check below compares like with like.
  const base = normalize(root).replace(/[\\/]+$/, '');
  return async function serveStatic(request, response, url) {
    if (!['GET', 'HEAD'].includes(request.method)) return false;
    const requested = decodeURIComponent(url.pathname);
    const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
    const target = normalize(join(base, relative));
    // Refuse anything that escapes the served directory, including through encoded segments.
    if (target !== base && !target.startsWith(base + sep)) {
      response.writeHead(403); response.end('Forbidden'); return true;
    }
    let info;
    try { info = await stat(target); } catch { info = null; }
    const file = info?.isDirectory() ? join(target, 'index.html') : target;
    const found = info?.isDirectory() ? await stat(file).catch(() => null) : info;
    if (!found?.isFile()) return false;
    response.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': found.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') { response.end(); return true; }
    await new Promise(resolve => createReadStream(file).on('close', resolve).on('error', resolve).pipe(response));
    return true;
  };
}
