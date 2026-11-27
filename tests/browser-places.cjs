// Browser check of the Places screen (increment 2a).
// Same bootstrap as tests/browser-c03.cjs: in-memory server, demo fixtures,
// app shell served from disk with an explicit allowlist.
// Uso: NODE_PATH=<deps> node tests/browser-places.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');

const ORIGIN = 'https://siteassistant.asassi.cloud';
const API_ORIGIN = 'https://api.siteassistant.asassi.cloud';
const appRoot = path.join(__dirname, '..', 'app');
const shell = ['index.html', 'app.mjs', 'api.mjs', 'webauthn-client.mjs', 'domain.mjs', 'hse-permissions.mjs',
  'dashboard-layout.mjs', 'offline.mjs', 'i18n.mjs', 'language.mjs', 'places-ui.mjs', 'place-selector.mjs',
  'assets-ui.mjs',
  'styles.css', 'fonts.css', 'manifest.webmanifest', 'assets/logo.svg'];

async function setup() {
  const { openDb } = await import('../server/db.mjs');
  const { createServer } = await import('../server/http.mjs');
  const { seed } = await import('../server/seed.mjs');
  const { provisionDemoFixture, withDemoEnvironment } = await import('./helpers/demo-seed.mjs');
  const { apply } = await import('../server/seed-demo.mjs');
  const db = await openDb(':memory:', { driver: 'sqlite' });
  await seed(db, { environment: 'test' });
  await provisionDemoFixture(db);
  await withDemoEnvironment(() => apply(db));
  const site = await db.get("SELECT * FROM sites WHERE code = 'FITT-03'");
  const server = createServer(db, { authBypassUser: '', production: false, staticDir: null,
    mailer: async () => { throw new Error('Unexpected mail'); }, storage: {} });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  return { db, server, browser, site, apiUrl: `http://127.0.0.1:${server.address().port}` };
}

async function openSession(env, viewport) {
  const context = await env.browser.newContext({ viewport, serviceWorkers: 'block', locale: 'it-IT' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      const response = await route.fetch({ url: `${env.apiUrl}${url.pathname}${url.search}`,
        headers: { ...request.headers(), origin: ORIGIN }, maxRedirects: 0 });
      return route.fulfill({ response });
    }
    if (![ORIGIN, API_ORIGIN].includes(url.origin)) return route.abort('blockedbyclient');
    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    if (!shell.includes(file) && !/^assets\/fonts\/[a-z0-9-]+\.woff2$/.test(file)) return route.abort('blockedbyclient');
    const contentType = ({ '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript',
      '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' })[path.extname(file)];
    return route.fulfill({ contentType, body: await fs.readFile(path.join(appRoot, file)) });
  });
  await page.goto(`${ORIGIN}/#today`);
  return { page, context, errors };
}

async function signIn(page, role, site) {
  await page.locator('#login-form [name=email]').fill(`${role}@example.invalid`);
  await page.locator('#login-form [name=password]').fill(`Local-${role}-5b!`);
  await page.locator('#login-form [type=submit]').click();
  await page.locator('#login-form').waitFor({ state: 'detached' });
  await page.locator(`#site-select option[value="${site.id}"]`).waitFor({ state: 'attached' });
  await page.selectOption('#site-select', site.id);
  await page.waitForFunction(() => !document.querySelector('#site-select').disabled);
}

async function main() {
  const env = await setup();
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const { page, context, errors } = await openSession(env, viewport);
      try {
        await signIn(page, 'owner', env.site);
        // No seed creates places: I create them through the API with the real session,
        // otherwise the view would show only the empty state.
        const created = await page.evaluate(async siteId => {
          const existing = await fetch(`/api/places?siteId=${siteId}`).then(response => response.json());
          if (Array.isArray(existing) && existing.length) return ['skip', 'skip', 'skip'];
          const post = (body) => fetch('/api/places', { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
            .then(async response => ({ status: response.status, body: await response.json() }));
          const building = await post({ siteId, name: 'Edificio A', kind: 'building' });
          const floor = await post({ siteId, name: 'Piano 1', kind: 'floor', parentId: building.body.id });
          const room = await post({ siteId, name: 'Sala pompe', kind: 'room', parentId: floor.body.id });
          return [building.status, floor.status, room.status];
        }, env.site.id);
        assert.ok(created.map(String).every(status => status === '201' || status === 'skip'), `Creazione luoghi: ${created.join(',')}`);
        await page.evaluate(() => { location.hash = '#places'; });
        await page.waitForFunction(() => location.hash === '#places');
        const tree = page.locator('[data-place-tree]').first();
        await tree.waitFor({ state: 'attached' });
        await page.locator('[data-place-tree] li, [data-place-tree] [data-place-id]').first().waitFor({ state: 'attached' });
        const count = await page.locator('[data-place-tree] li, [data-place-tree] [data-place-id]').count();
        assert.ok(count > 0, `Albero luoghi vuoto a ${viewport.width}px`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, `Overflow orizzontale ${overflow}px a ${viewport.width}px`);
        assert.deepEqual(errors, [], `Errori di pagina: ${errors.join(' | ')}`);
        await page.screenshot({ path: `/tmp/places-${viewport.width}.png`, fullPage: false });
        console.log(`PASS ${viewport.width}px: ${count} nodi visibili, nessun overflow, nessun errore JS`);
      } finally { await context.close(); }
    }
  } finally {
    await env.browser.close();
    await new Promise(resolve => env.server.close(resolve));
    await env.db.close();
  }
}

main().catch(error => { console.error('FAIL', error.message); process.exit(1); });
