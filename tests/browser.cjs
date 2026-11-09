const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

async function contains(locator, text) {
  await locator.filter({ hasText: text }).waitFor();
  assert.ok((await locator.textContent()).includes(text));
}

// Serve local assets at the allowed frontend origin and route API requests to an
// isolated in-memory backend. This test never writes to the deployed service.
async function run() {
  const { openDb, closeDb } = await import('../server/db.mjs');
  const { createServer } = await import('../server/http.mjs');
  const { seed } = await import('../server/seed.mjs');
  const db = await openDb(':memory:', { driver: 'sqlite' });
  const server = createServer(db);
  let browser;
  try {
    await seed(db);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const apiUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = 'https://siteassistant.asassi.cloud';
    let failReads = false, failWrites = false;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === 'https://api.siteassistant.asassi.cloud') {
        if ((failReads && request.method() === 'GET') || (failWrites && request.method() === 'POST')) return route.abort('failed');
        const response = await route.fetch({ url: `${apiUrl}${url.pathname}${url.search}`, headers: { ...request.headers(), origin } });
        return route.fulfill({ response });
      }
      if (url.origin === origin) {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (!['index.html', 'app.mjs', 'api.mjs', 'domain.mjs', 'i18n.mjs', 'styles.css'].includes(file)) return route.fulfill({ status: 404, body: '' });
        const contentType = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript';
        return route.fulfill({ contentType, body: await fs.readFile(path.join(__dirname, '../app', file)) });
      }
      return route.abort();
    });
    await context.addInitScript(() => {
      // No data or preferences may depend on browser storage.
      Storage.prototype.getItem = Storage.prototype.setItem = () => { throw new Error('Storage is disabled'); };
    });
    await page.goto(origin);
    await page.waitForSelector('#login-form');
    assert.equal(await page.locator('[data-metric="execution"]').count(), 0);
    async function signIn(role) {
      await page.locator('#login-form [name="email"]').fill(`${role}@example.invalid`);
      await page.locator('#login-form [name="password"]').fill(`Local-${role}-5b!`);
      await page.locator('#login-form [type="submit"]').click();
      await page.waitForSelector('#login-form', { state: 'detached' });
      await page.waitForSelector('#site-select option');
    }
    await signIn('owner');
    const cookies = await context.cookies();
    assert.ok(cookies.find(cookie => cookie.name === 'sa_session')?.httpOnly);
    assert.equal(await page.evaluate(() => document.cookie.includes('sa_session')), false);
    await page.waitForSelector('[data-metric="execution"]');
    assert.equal(await page.locator('#site-select option').count(), 2);
    assert.equal(await page.locator('[data-metric="review"]').textContent(), '0');
    await page.screenshot({ path: path.join(os.tmpdir(), 'siteassistant-desktop.png'), fullPage: true });

    await page.locator('a[href="#tasks"]').click();
    await page.getByRole('button', { name: 'Nuova attività', exact: true }).click();
    await page.locator('[name="title"]').fill('Synthetic workflow task');
    await page.locator('[name="company"]').fill('Demo company');
    await page.locator('[name="area"]').fill('Area TEST');
    await page.locator('[name="assignee"]').fill('Example executor & crew');
    await page.locator('[name="reviewer"]').fill('Example executor & crew');
    await page.getByRole('button', { name: 'Salva', exact: true }).click();
    await contains(page.locator('.form-error'), 'persone diverse');
    await page.locator('[name="reviewer"]').fill('Example verifier');
    failWrites = true;
    await page.getByRole('button', { name: 'Salva', exact: true }).click();
    await contains(page.locator('.form-error'), 'non raggiungibile');
    assert.equal(await page.locator('[name="title"]').inputValue(), 'Synthetic workflow task');
    failWrites = false;
    await page.getByRole('button', { name: 'Salva', exact: true }).click();
    await page.waitForSelector('#modal', { state: 'hidden' });
    await page.locator('#filter-search').fill('Synthetic workflow');
    assert.equal(await page.locator('.task-card').count(), 1);
    await page.locator('#filter-person').selectOption('Example executor & crew');
    await page.locator('.task-card').click();
    await page.waitForSelector('.timeline');
    async function transition(to, note = '', reason = '') {
      await page.locator(`[data-command="transition"][data-to="${to}"]`).click();
      if (note) await page.locator('[name="note"]').fill(note);
      if (reason) await page.locator('[name="reason"]').fill(reason);
      await page.getByRole('button', { name: 'Salva', exact: true }).click();
      await page.waitForSelector(`.modal-body > p .badge.${to}`);
    }
    await transition('in_progress');
    await transition('to_verify', 'Evidence DEMO-01');
    await page.locator('[data-to="closed"]').click();
    await page.locator('[name="note"]').fill('Checked');
    await page.getByRole('button', { name: 'Salva', exact: true }).click();
    await contains(page.locator('.form-error'), 'Transizione non consentita');
    await page.keyboard.press('Escape');
    await page.locator('#logout').click();
    await page.waitForSelector('#login-form');
    await signIn('verifier');
    await page.locator('#filter-search').fill('Synthetic workflow');
    await page.locator('.task-card').click();
    await page.waitForSelector('.timeline');
    await transition('closed', 'Checked');
    await transition('in_progress', '', 'Follow-up correction');
    await transition('blocked', '', 'Waiting for material');
    assert.equal(await page.locator('[data-command="transition"]').count(), 0);
    await contains(page.locator('.timeline'), 'Evidence DEMO-01');
    await contains(page.locator('.timeline'), 'Follow-up correction');
    await contains(page.locator('.timeline'), 'Waiting for material');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Elenco', exact: true }).click();
    const csvEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Esporta CSV', exact: true }).click();
    const csvText = await fs.readFile(await (await csvEvent).path(), 'utf8');
    assert.match(csvText, /Example executor & crew/);
    assert.doesNotMatch(csvText, /&amp;/);

    await page.locator('a[href="#diary"]').click();
    await page.locator('#report-date').fill('2026-01-10');
    await page.locator('#report-date').dispatchEvent('change');
    await page.getByRole('button', { name: 'Aggiungi contributo', exact: true }).first().click();
    await page.locator('[name="shift"]').selectOption('night');
    await page.locator('[name="plan"]').fill('Test night plan');
    await page.locator('[name="actual"]').fill('<img src=x onerror="window.demoXss=true">');
    await page.locator('[name="next"]').fill('Test handover');
    await page.getByRole('button', { name: 'Salva', exact: true }).click();
    await page.waitForSelector('.diary-entry');
    assert.equal(await page.locator('.diary-entry img').count(), 0);
    assert.equal(await page.evaluate(() => window.demoXss), undefined);
    await page.getByRole('button', { name: 'Aggiungi contributo', exact: true }).first().click();
    await page.locator('[name="shift"]').selectOption('night');
    await page.getByRole('button', { name: 'Salva', exact: true }).click();
    await contains(page.locator('.form-error'), 'Esiste già un contributo');
    await page.keyboard.press('Escape');
    await page.locator('#language').click();
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    await contains(page.locator('.diary-entry'), 'Night shift');

    await page.locator('#logout').click();
    await page.waitForSelector('#login-form');
    await signIn('owner');
    await page.locator('a[href="#sites"]').click();
    await page.getByRole('button', { name: 'New site', exact: true }).click();
    await page.locator('[name="code"]').fill('TEST-03');
    await page.locator('[name="name"]').fill('Synthetic site');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForSelector('#modal', { state: 'hidden' });
    assert.equal(await page.locator('#site-select option:checked').textContent(), 'Synthetic site');
    await page.locator('a[href="#tasks"]').click();
    assert.equal(await page.locator('.task-card').count(), 0);
    await page.reload();
    await page.waitForSelector('#task-results');
    assert.equal(await page.locator('#site-select option').count(), 3);
    await page.locator('#site-select').selectOption({ index: 2 });
    for (const view of ['overview', 'sites', 'tasks', 'diary']) {
      await page.locator(`a[href="#${view}"]`).click();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `mobile overflow: ${view}`);
    }
    await page.screenshot({ path: path.join(os.tmpdir(), 'siteassistant-mobile.png'), fullPage: true });
    failReads = true;
    await page.reload();
    await contains(page.locator('#main [role="alert"]'), 'non raggiungibile');
    failReads = false;
    await page.getByRole('button', { name: 'Riprova', exact: true }).click();
    await page.waitForSelector('#report-date');
    assert.deepEqual(errors, []);
    console.log('PASS: API loading/creation, transitions/events, login/logout, HttpOnly cookie, independent session verification, blocked state, CSV, diary uniqueness, escaping, IT/EN, reload, mobile and network error recovery.');
  } finally {
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await closeDb(db);
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
