// Verifica browser della schermata Asset (incremento 2b).
// Stesso bootstrap di tests/browser-places.cjs: server in memoria, fixtures demo,
// guscio dell'app servito dal disco con allowlist esplicita.
// Uso: NODE_PATH=<deps> node tests/browser-assets.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');

const ORIGIN = 'https://app.example.invalid';
const API_ORIGIN = 'https://api.example.invalid';
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

// Crea luoghi e asset con la sessione reale della pagina, se non ci sono gia'.
async function seedAssets(page, siteId) {
  return page.evaluate(async siteId => {
    const get = (url) => fetch(url).then(r => r.json());
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));

    let places = await get(`/api/places?siteId=${siteId}`);
    if (!Array.isArray(places) || !places.length) {
      const building = await post('/api/places', { siteId, name: 'Edificio A', kind: 'building' });
      const floor = await post('/api/places', { siteId, name: 'Piano 1', kind: 'floor', parentId: building.body.id });
      await post('/api/places', { siteId, name: 'Sala pompe', kind: 'room', parentId: floor.body.id });
      await post('/api/places', { siteId, name: 'Magazzino', kind: 'room', parentId: building.body.id });
      places = await get(`/api/places?siteId=${siteId}`);
    }
    const rooms = places.filter(p => p.kind === 'room');
    const existing = await get(`/api/assets?siteId=${siteId}`);
    if (Array.isArray(existing) && existing.length) {
      return { places: places.length, assets: existing.length, first: existing[0].tag,
        roomName: rooms[0]?.name ?? null };
    }
    const a = await post('/api/assets', { siteId, tag: 'PUMP-01', name: 'Pompa centrifuga', category: 'Pompe',
      status: 'installed', serialNumber: 'SN-1001', manufacturer: 'Acme', model: 'X200',
      installedOn: '2025-01-10',
      warrantyStart: '2025-01-10', warrantyEnd: '2027-01-10', warrantyProvider: 'Acme Service',
      placeId: rooms[0].id, validFrom: '2025-01-10T08:00:00.000Z' });
    const b = await post('/api/assets', { siteId, tag: 'PUMP-02', name: 'Pompa sommergibile', category: 'Pompe',
      status: 'planned', serialNumber: 'SN-2002' });
    if (![201, 409].includes(a.status) || ![201, 409].includes(b.status)) {
      throw new Error(`Creazione asset: ${a.status}/${b.status} ${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`);
    }
    const list = await get(`/api/assets?siteId=${siteId}`);
    return { places: places.length, assets: list.length, first: list[0].tag, roomName: rooms[0].name };
  }, siteId);
}

async function main() {
  const env = await setup();
  const report = [];
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const { page, context, errors } = await openSession(env, viewport);
      try {
        await signIn(page, 'owner', env.site);
        const seeded = await seedAssets(page, env.site.id);
        assert.ok(seeded.assets >= 2, `Asset non creati: ${JSON.stringify(seeded)}`);

        await page.evaluate(() => { location.hash = '#assets'; });
        await page.waitForFunction(() => location.hash === '#assets');
        await page.locator('.assets-view').waitFor({ state: 'attached' });
        await page.locator('[data-asset-open]').first().waitFor({ state: 'attached' });

        // 1. Elenco completo.
        const listed = await page.locator('[data-asset-open]').count();
        assert.ok(listed >= 2, `Elenco asset incompleto a ${viewport.width}px: ${listed}`);

        // 2. Ricerca: filtro per tag restringe i risultati.
        await page.locator('[name=assetSearch]').fill('PUMP-02');
        const narrowed = await page.locator('[data-asset-open]').count();
        assert.equal(narrowed, 1, `Ricerca non filtra a ${viewport.width}px: ${narrowed}`);
        await page.locator('[name=assetSearch]').fill('');

        // 3. Filtro per stato.
        await page.selectOption('[name=assetStatus]', 'planned');
        const planned = await page.locator('[data-asset-open]').count();
        assert.equal(planned, 1, `Filtro stato non applicato: ${planned}`);
        await page.selectOption('[name=assetStatus]', '');

        // 4. Scheda con storico posizioni: apri il primo asset installato.
        const installedRow = page.locator('[data-asset-open]', { hasText: 'PUMP-01' }).first();
        await installedRow.click();
        const detail = page.locator('[data-asset-detail]');
        await detail.locator('h2', { hasText: 'PUMP-01' }).waitFor({ state: 'attached' });
        const detailText = await detail.innerText();
        if (process.env.SA_DEBUG) console.log('DETAIL>>>', detailText.replace(/\n/g, ' | ').slice(0, 800));
        for (const expected of ['SN-1001', 'Acme', 'X200', 'Edificio A', seeded.roomName]) {
          assert.ok(detailText.includes(expected), `Scheda priva di «${expected}» a ${viewport.width}px`);
        }
        const historyItems = await detail.locator('.places-history li').count();
        assert.ok(historyItems >= 1, `Storico posizioni vuoto a ${viewport.width}px`);

        // 5. Azioni per ruolo: un owner vede i pulsanti, un viewer no.
        const ownerActions = await detail.locator('[data-asset-action]').count();
        assert.ok(ownerActions >= 1, `Owner senza azioni a ${viewport.width}px`);

        // 6. Dialogo di dismissione con motivo obbligatorio (senza inviare).
        await page.locator('[data-asset-action=decommission]').click();
        const dialog = page.locator('dialog.assets-dialog[open]');
        await dialog.waitFor({ state: 'attached' });
        const submit = dialog.locator('button[type=submit]');
        await submit.click();
        // Il motivo e' obbligatorio: la validazione nativa blocca l'invio, il dialogo resta aperto
        // e l'asset non cambia stato.
        assert.ok(await dialog.isVisible(), `Dismissione senza motivo ha chiuso il dialogo a ${viewport.width}px`);
        const statusAfter = await page.evaluate(async siteId => {
          const list = await fetch(`/api/assets?siteId=${siteId}`).then(r => r.json());
          return (list.find(a => a.tag === 'PUMP-01') || {}).status;
        }, env.site.id);
        assert.equal(statusAfter, 'installed', `Stato cambiato senza motivo: ${statusAfter}`);
        await dialog.locator('[data-asset-cancel]').click();
        await dialog.waitFor({ state: 'detached' }).catch(() => {});
        await page.locator('dialog.assets-dialog:not([open])').waitFor({ state: 'attached' }).catch(() => {});

        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, `Overflow orizzontale ${overflow}px a ${viewport.width}px`);
        assert.deepEqual(errors, [], `Errori di pagina: ${errors.join(' | ')}`);
        await page.screenshot({ path: `/tmp/assets-${viewport.width}.png`, fullPage: false });
        report.push(`PASS ${viewport.width}px: ${listed} asset, 1 dopo ricerca, scheda con ${historyItems} posizioni, ${ownerActions} azioni, nessun overflow, nessun errore JS`);
      } finally { await context.close(); }
    }

    // 7. Un viewer non deve vedere azioni di mutazione.
    {
      const { page, context, errors } = await openSession(env, { width: 1440, height: 900 });
      try {
        await signIn(page, 'viewer', env.site);
        await page.evaluate(() => { location.hash = '#assets'; });
        await page.locator('[data-asset-open]').first().waitFor({ state: 'attached' });
        await page.locator('[data-asset-open]').first().click();
        await page.locator('[data-asset-detail] h2').first().waitFor({ state: 'attached' });
        await page.waitForTimeout(300);
        const viewerActions = await page.locator('[data-asset-action]').count();
        assert.equal(viewerActions, 0, `Il viewer vede ${viewerActions} azioni di mutazione`);
        assert.deepEqual(errors, [], `Errori di pagina (viewer): ${errors.join(' | ')}`);
        report.push('PASS viewer: 0 azioni di mutazione, nessun errore JS');
      } finally { await context.close(); }
    }

    for (const line of report) console.log(line);
  } finally {
    await env.browser.close();
    await new Promise(resolve => env.server.close(resolve));
    await env.db.close();
  }
}

main().catch(error => { console.error('FAIL', error.message); process.exit(1); });
