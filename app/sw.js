import { createApi } from './api.mjs';
import { getMirror, replayOps, SYNC_TAG } from './offline.mjs';

const VERSION = 'siteassistant-v15-13';
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data-`;
const shellUrls = ['./', './index.html', './styles.css', './fonts.css', './app.mjs', './api.mjs', './domain.mjs', './dashboard-layout.mjs', './i18n.mjs', './offline.mjs', './manifest.webmanifest', './assets/logo.svg'].map(path => new URL(path, self.registration.scope).href);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(shellUrls)));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('siteassistant-v') && !key.startsWith(VERSION)) await caches.delete(key);
    await self.clients.claim();
  })());
});
const notify = async message => {
  for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage(message);
};
async function runtime(request, event) {
  const active = await getMirror('active');
  if (!active) return fetch(request);
  const url = new URL(request.url), base = new URL(active.baseUrl, self.registration.scope);
  const prefix = base.pathname.replace(/\/$/, '');
  if (url.origin !== base.origin || !new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/(sites|tasks|diary|wbs|attachments)(/[^/]+)?$`).test(url.pathname)) return fetch(request);
  // Binary downloads and all auth endpoints are deliberately outside the data cache.
  if (/\/attachments\//.test(url.pathname)) return fetch(request);
  const cache = await caches.open(`${DATA}${encodeURIComponent(active.scope)}`);
  const cached = await cache.match(request);
  const update = fetch(request).then(async response => {
    if (response.status === 401 || response.status === 403) {
      await cache.delete(request);
      const code = await response.clone().json().then(body => body.code, () => undefined);
      await notify({ type: 'offline-access-denied', scope: active.scope, status: response.status, code });
    } else if (response.ok && response.headers.get('content-type')?.includes('application/json') && (await getMirror('active'))?.scope === active.scope) {
      await cache.put(request, response.clone());
    }
    return response;
  });
  event.waitUntil(update.catch(() => {}));
  // Explicit refresh after replay must not return stale data or hide authorization errors.
  return cached && request.cache !== 'reload' ? cached : update;
}
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (shellUrls.includes(url.href) || (request.mode === 'navigate' && url.origin === self.location.origin && url.pathname.startsWith(new URL(self.registration.scope).pathname) && !url.pathname.includes('/api/'))) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      return await cache.match(request.mode === 'navigate' ? shellUrls[1] : request) || fetch(request);
    })());
  } else if (url.pathname.includes('/api/')) {
    event.respondWith(runtime(request, event));
  }
});
self.addEventListener('sync', event => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil((async () => {
    const active = await getMirror('active');
    if (!active) return;
    const api = createApi({ baseUrl: active.baseUrl, fresh: true });
    try {
      const result = await replayOps(api, { scope: active.scope, userId: active.session.user.id });
      await notify({ type: 'offline-synced', scope: active.scope });
      if (result.pending) throw new Error('Pending operations need connectivity');
    } catch (error) {
      if (error.status === 401) { await notify({ type: 'offline-access-denied', scope: active.scope, status: 401 }); return; }
      throw error;
    }
  })());
});
