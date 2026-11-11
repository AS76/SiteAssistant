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
  const mail = [];
  const server = createServer(db, { mailer: async message => { mail.push(message); }, ownerEmail: 'owner@example.invalid', publicUrl: 'https://app.example.invalid' });
  let browser;
  try {
    await seed(db);
    const { attachSyntheticIngestion, wbsSource } = await import('./helpers/wbs.mjs');
    const { importWbs } = await import('../server/wbs.mjs');
    await attachSyntheticIngestion(db);
    const wbsSite = await db.get('SELECT * FROM sites ORDER BY created_at, id LIMIT 1');
    const owner = await db.get("SELECT * FROM users WHERE email = 'owner@example.invalid'");
    await wbsSource(db, wbsSite);
    await importWbs(db, wbsSite.id, owner);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const apiUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = 'https://siteassistant.asassi.cloud';
    let failReads = false, failWrites = false, failLayoutReads = false, failLayoutWrites = false;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === 'https://api.siteassistant.asassi.cloud') {
        if (url.pathname === '/api/dashboard/layout' && ((failLayoutReads && request.method() === 'GET')
          || (failLayoutWrites && request.method() !== 'GET'))) return route.abort('failed');
        if ((failReads && request.method() === 'GET') || (failWrites && request.method() === 'POST')) return route.abort('failed');
        const response = await route.fetch({ url: `${apiUrl}${url.pathname}${url.search}`, headers: { ...request.headers(), origin } });
        return route.fulfill({ response });
      }
      if (url.origin === origin) {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (!['index.html', 'app.mjs', 'api.mjs', 'domain.mjs', 'dashboard-layout.mjs', 'offline.mjs', 'i18n.mjs', 'styles.css'].includes(file)) return route.fulfill({ status: 404, body: '' });
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
    await page.locator('[data-command="request-access"]').click();
    await page.locator('#request-form [name="email"]').fill('applicant@example.invalid');
    await page.locator('#request-form [type="submit"]').click();
    await page.waitForSelector('#modal', { state: 'hidden' });
    assert.equal(mail.length, 1);
    const reviewUrl = new URL(/Review request: (https:\/\/[^\s]+)/.exec(mail[0].text)[1]);
    const review = await context.newPage();
    await review.goto(`https://api.siteassistant.asassi.cloud${reviewUrl.pathname}${reviewUrl.search}`);
    assert.equal((await db.get('SELECT status FROM signup_requests')).status, 'pending');
    assert.equal(mail.length, 1);
    await contains(review.locator('main'), 'applicant@example.invalid');
    assert.equal(await review.locator('form').getAttribute('method'), 'post');
    assert.equal(await review.getByRole('button', { name: 'Approva', exact: true }).count(), 1);
    await Promise.all([
      review.waitForURL('https://api.siteassistant.asassi.cloud/api/auth/request/decide'),
      review.getByRole('button', { name: 'Rifiuta', exact: true }).click(),
    ]);
    await contains(review.locator('main'), 'Request rejected');
    assert.equal((await db.get('SELECT status FROM signup_requests')).status, 'rejected');
    assert.equal(mail.length, 1);
    await review.close();
    await signIn('owner');
    const cookies = await context.cookies();
    assert.ok(cookies.find(cookie => cookie.name === 'sa_session')?.httpOnly);
    assert.equal(await page.evaluate(() => document.cookie.includes('sa_session')), false);
    await page.waitForSelector('[data-metric="execution"]');
    assert.equal(await page.locator('#site-select option').count(), 2);
    assert.equal(await page.locator('[data-metric="review"]').textContent(), '0');
    await page.screenshot({ path: path.join(os.tmpdir(), 'siteassistant-desktop.png'), fullPage: true });

    // HSE is a separate register: factual fields only, with restricted reads and writes.
    await page.locator('#navigation a[href="#hse"]').click();
    await contains(page.locator('#main'), 'Nessun dato sanitario: si registrano fatti, luoghi e misure.');
    await page.locator('[data-command="hse-new"]').click();
    await page.locator('#hse-form [name="occurredOn"]').fill('2026-11-10');
    await page.locator('#hse-form [name="eventNo"]').fill('SYN-HSE-001');
    await page.locator('#hse-form [name="location"]').fill('Synthetic zone A');
    await page.locator('#hse-form [name="personsInvolved"]').fill('0');
    await page.locator('#hse-form [name="measures"]').fill('<b>Barrier installed</b>');
    assert.equal(await page.locator('#hse-form [name="employeeId"]').count(), 0);
    await page.locator('#hse-form [type="submit"]').click();
    await page.waitForSelector('#modal', { state: 'hidden' });
    await contains(page.locator('.core-table tbody'), 'SYN-HSE-001');
    assert.equal(await page.locator('.core-table tbody b').count(), 0);
    await page.locator('[data-command="hse-edit"]').click();
    assert.equal(await page.locator('#hse-form [name="personsInvolved"]').inputValue(), '0');
    await page.locator('#hse-form [name="type"]').selectOption('observation');
    await page.locator('#hse-form [name="severity"]').selectOption('high');
    await page.locator('#hse-form [type="submit"]').click();
    await page.waitForSelector('#modal', { state: 'hidden' });
    await contains(page.locator('.core-table tbody'), 'Osservazioni');
    await page.locator('[data-core-filter="type"]').selectOption('near_miss');
    await contains(page.locator('#main'), 'Nessun evento HSE');
    await page.locator('[data-core-filter="type"]').selectOption('observation');
    await page.locator('[data-core-filter="severity"]').selectOption('high');
    await page.locator('[data-core-filter="from"]').fill('2026-11-10');
    await page.locator('[data-core-filter="from"]').dispatchEvent('change');
    await page.locator('[data-core-filter="to"]').fill('2026-11-10');
    await page.locator('[data-core-filter="to"]').dispatchEvent('change');
    await contains(page.locator('.core-table tbody'), 'SYN-HSE-001');
    await page.locator('#language').click();
    await contains(page.locator('#main'), 'No health data: record facts, locations and measures.');
    await page.locator('#language').click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile overflow: HSE');
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const role of ['editor', 'verifier', 'viewer']) {
      await page.locator('#logout').click(); await page.waitForSelector('#login-form');
      await signIn(role);
      await page.evaluate(() => { location.hash = 'hse'; });
      if (role === 'viewer') await contains(page.locator('#main'), 'Il registro HSE è riservato');
      else {
        await contains(page.locator('.core-table tbody'), 'SYN-HSE-001');
        assert.equal(await page.locator('[data-command="hse-edit"]').count(), role === 'editor' ? 1 : 0);
      }
      assert.equal(await page.locator('[data-command="hse-new"]').count(), role === 'editor' ? 1 : 0);
    }
    await page.locator('#logout').click(); await page.waitForSelector('#login-form');
    await signIn('owner');
    await page.evaluate(() => { location.hash = 'hse'; });
    await page.locator('[data-command="hse-delete"]').click();
    await contains(page.locator('#hse-delete-form'), 'SYN-HSE-001');
    await page.locator('#hse-delete-form [type="submit"]').click();
    await page.waitForSelector('#modal', { state: 'hidden' });
    await contains(page.locator('#main'), 'Nessun evento HSE');
    await page.evaluate(() => { location.hash = 'overview'; });
    await page.waitForSelector('[data-metric="execution"]');

    // Module access: owner matrix, locked anchors, effective navigation, hash denial and site isolation.
    const accessSite = await page.locator('#site-select').inputValue();
    const otherAccessSite = await page.locator('#site-select option').evaluateAll(options => options.map(option => option.value).find(id => id !== document.querySelector('#site-select').value));
    const accessEditor = await db.get("SELECT id FROM users WHERE email = 'editor@example.invalid'");
    const accessCheckbox = module => page.locator(`[data-member-access][data-member="${accessEditor.id}"][data-module="${module}"]`);
    await page.evaluate(() => { location.hash = 'sites'; });
    await page.waitForSelector('[data-member-access]');
    for (const module of ['overview', 'sites']) {
      assert.equal(await accessCheckbox(module).isChecked(), true);
      assert.equal(await accessCheckbox(module).isDisabled(), true);
    }
    const ownerChecks = page.locator(`[data-member-access][data-member="${owner.id}"]`);
    assert.equal(await ownerChecks.count(), 12);
    assert.equal(await ownerChecks.evaluateAll(inputs => inputs.every(input => input.checked && input.disabled)), true);
    const denyAccess = page.waitForResponse(response => response.url().includes('/api/member-access') && response.request().method() === 'PUT');
    await accessCheckbox('tasks').uncheck();
    assert.equal((await denyAccess).status(), 200);
    await page.waitForFunction(() => !document.querySelector('[data-member-access][data-module="tasks"]:not(:checked)')?.disabled);
    await page.locator('#logout').click(); await page.waitForSelector('#login-form');
    await signIn('editor');
    assert.equal(await page.locator('.module-access').count(), 0);
    assert.equal(await page.locator('#navigation a[href="#tasks"]').count(), 0);
    await page.evaluate(() => { location.hash = 'tasks'; });
    await contains(page.locator('#main'), 'Modulo non disponibile');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('#navigation a[href="#tasks"]').count(), 0);
    assert.equal(await page.locator('#navigation a[href="#overview"]').count(), 1);
    await page.locator('[data-command="more-nav"]').click();
    assert.equal(await page.locator('.more-nav a[href="#tasks"]').count(), 0);
    assert.equal(await page.locator('.more-nav a[href="#sites"]').count(), 1);
    await page.keyboard.press('Escape');
    await page.locator('#site-select').selectOption(otherAccessSite);
    await page.waitForSelector('#task-results');
    assert.equal(await page.locator('#navigation a[href="#tasks"]').count(), 1);
    await page.locator('#site-select').selectOption(accessSite);
    await contains(page.locator('#main'), 'Modulo non disponibile');
    await page.locator('#language').click();
    await contains(page.locator('#main'), 'Module unavailable');
    await page.locator('#language').click();
    await page.locator('#logout').click(); await page.waitForSelector('#login-form');
    await signIn('owner');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#site-select').selectOption(accessSite);
    await page.evaluate(() => { location.hash = 'sites'; });
    await page.waitForSelector('[data-member-access]');
    const allowAccess = page.waitForResponse(response => response.url().includes('/api/member-access') && response.request().method() === 'PUT');
    await accessCheckbox('tasks').check();
    assert.equal((await allowAccess).status(), 200);
    await page.evaluate(() => { location.hash = 'overview'; });

    // Personal overview: selection, stable order, empty data, cancel, errors and site scoping.
    const allWidgets = ['kpi_open_deviations', 'kpi_booked_hours', 'kpi_open_claims', 'kpi_settled_claims',
      'deviations_by_status', 'progress_by_section', 'hours_by_week', 'earned_value', 'priority_work', 'daily_pulse', 'journal_today'];
    const overviewReady = () => page.waitForSelector('#overview-widgets[aria-busy="false"]');
    const visibleWidgets = () => page.locator('#overview-widgets [data-widget]').evaluateAll(rows => rows.map(row => row.dataset.widget));
    const openLayout = async () => {
      await page.locator('[data-command="layout-open"]').click();
      await page.waitForSelector('#dashboard-layout-form');
    };
    const layoutRow = id => page.locator(`[data-layout-widget="${id}"]`);
    await overviewReady();
    assert.deepEqual(await visibleWidgets(), allWidgets);
    await openLayout();
    assert.equal(await page.locator('.layout-widgets input:checked').count(), 11);
    assert.ok(await layoutRow('kpi_open_deviations').locator('[data-direction=up]').isDisabled());
    assert.ok(await layoutRow('journal_today').locator('[data-direction=down]').isDisabled());
    await layoutRow('daily_pulse').locator('input').uncheck();
    await page.locator('#dashboard-layout-form [data-command="close-modal"]').click();
    assert.deepEqual(await visibleWidgets(), allWidgets);
    assert.equal(await db.get('SELECT id FROM dashboard_layouts'), undefined);
    await openLayout();
    for (const input of await page.locator('.layout-widgets input').all()) await input.uncheck();
    await page.locator('#dashboard-layout-form [type=submit]').click();
    await contains(page.locator('#dashboard-layout-form .form-error'), 'Scegli da 1 a 11');
    const chosenWidgets = ['journal_today', 'kpi_booked_hours', 'kpi_open_deviations', 'hours_by_week', 'earned_value'];
    for (const id of chosenWidgets) await layoutRow(id).locator('input').check();
    await layoutRow('kpi_booked_hours').locator('[data-direction=up]').click();
    for (let i = 0; i < 10; i++) await layoutRow('journal_today').locator('[data-direction=up]').click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile overview editor overflow');
    await page.setViewportSize({ width: 1440, height: 1000 });
    failLayoutWrites = true;
    await page.locator('#dashboard-layout-form [type=submit]').click();
    await contains(page.locator('#dashboard-layout-form .form-error'), 'non raggiungibile');
    assert.equal(await page.locator('.layout-widgets input:checked').count(), 5);
    failLayoutWrites = false;
    await page.locator('#dashboard-layout-form [type=submit]').click();
    await page.waitForSelector('#modal', { state: 'hidden' });
    await overviewReady();
    const visualOrder = ['kpi_booked_hours', 'kpi_open_deviations', 'journal_today', 'hours_by_week', 'earned_value'];
    assert.deepEqual(await visibleWidgets(), visualOrder);
    assert.deepEqual(JSON.parse((await db.get('SELECT widgets_json FROM dashboard_layouts')).widgets_json), chosenWidgets);
    await contains(page.locator('[data-widget="hours_by_week"]'), 'Nessun risultato');
    await contains(page.locator('[data-widget="earned_value"]'), 'NO_PLANNED_HOURS');
    const overviewSite = await page.locator('#site-select').inputValue();
    await page.locator('#site-select').selectOption({ index: 1 });
    await overviewReady();
    assert.deepEqual(await visibleWidgets(), allWidgets);
    await page.locator('#site-select').selectOption(overviewSite);
    await overviewReady();
    assert.deepEqual(await visibleWidgets(), visualOrder);
    await page.reload();
    await overviewReady();
    assert.deepEqual(await visibleWidgets(), visualOrder);
    failLayoutReads = true;
    await page.locator('a[href="#tasks"]').click();
    await page.locator('a[href="#overview"]').click();
    await overviewReady();
    assert.deepEqual(await visibleWidgets(), allWidgets);
    await openLayout();
    await contains(page.locator('#dashboard-layout-form'), 'Layout non disponibile');
    await page.keyboard.press('Escape');
    failLayoutReads = false;
    await openLayout();
    assert.equal(await page.locator('.layout-widgets input:checked').count(), 5);
    await page.locator('[data-command="layout-reset"]').click();
    await page.waitForSelector('#modal', { state: 'hidden' });
    await overviewReady();
    assert.deepEqual(await visibleWidgets(), allWidgets);
    assert.equal(await db.get('SELECT id FROM dashboard_layouts'), undefined);

    await page.locator('a[href="#wbs"]').click();
    await page.waitForSelector('.wbs-tree');
    await contains(page.locator('#main'), 'Padre sintetico');
    assert.equal(await page.locator('.wbs-tree li').count(), 8);
    await page.locator('[data-command="wbs-collapse"]').click();
    assert.equal(await page.locator('.wbs-tree details[open]').count(), 0);
    await page.locator('[data-command="wbs-expand"]').click();
    assert.ok(await page.locator('.wbs-tree details[open]').count() > 0);
    await page.locator('[data-command="wbs-view"][data-value="flat"]').click();
    assert.equal(await page.locator('#main tbody tr').count(), 8);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile WBS table overflow');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#site-select').selectOption({ index: 1 });
    await contains(page.locator('#main'), 'Nessuna struttura importata');
    await page.locator('#site-select').selectOption(wbsSite.id);
    await page.waitForSelector('#main tbody tr');
    failReads = true;
    await page.locator('[data-command="wbs-reload"]').click();
    await contains(page.locator('#main [role="alert"]'), 'non raggiungibile');
    failReads = false;
    await page.locator('[data-command="wbs-reload"]').click();
    await page.waitForSelector('#main tbody tr');
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
    for (const view of ['overview', 'sites', 'tasks', 'wbs', 'diary']) {
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
    await page.locator('#logout').click();
    await page.waitForSelector('#login-form');
    await page.locator('[data-command="forgot-password"]').click();
    await page.locator('#forgot-form [name="email"]').fill('owner@example.invalid');
    await page.locator('#forgot-form [type="submit"]').click();
    await page.waitForSelector('#modal', { state: 'hidden' });
    const temporary = /Temporary password: ([^\s]+)/.exec(mail.at(-1).text)[1];
    await page.locator('#login-form [name="email"]').fill('owner@example.invalid');
    await page.locator('#login-form [name="password"]').fill(temporary);
    await page.locator('#login-form [type="submit"]').click();
    await page.waitForSelector('#password-banner:not([hidden])');
    // The banner does not block navigation, even on mobile and without a modal.
    await page.locator('a[href="#tasks"]').click();
    await page.locator('#language').click();
    await contains(page.locator('#password-banner'), 'Change password');
    await page.locator('[data-command="change-password"]').click();
    await page.locator('[name="current_password"]').fill('Incorrect-password!');
    await page.locator('[name="new_password"]').fill('Synthetic-updated-password!');
    await page.locator('[name="confirm_password"]').fill('Synthetic-mismatched-password!');
    await page.locator('#password-form [type="submit"]').click();
    await contains(page.locator('#password-form .form-error'), 'do not match');
    await page.locator('[name="confirm_password"]').fill('Synthetic-updated-password!');
    await page.locator('#password-form [type="submit"]').click();
    await contains(page.locator('#password-form .form-error'), 'Invalid email or password');
    assert.equal(await page.locator('#login-form').count(), 0);
    await page.locator('[name="current_password"]').fill(temporary);
    await page.locator('#password-form [type="submit"]').click();
    await page.waitForSelector('#modal', { state: 'hidden' });
    assert.equal(await page.locator('#password-banner').isVisible(), false);
    await page.reload();
    await page.waitForSelector('#task-results');
    assert.equal(await page.locator('#password-banner').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('PASS: personal overview widgets/ordering/reset/site scoping/empty states/error fallback/mobile, WBS tree/flat/synthetic parents/site switching/error recovery, API loading/creation, transitions/events, login/logout, HttpOnly cookie, independent session verification, blocked state, CSV, diary uniqueness, escaping, IT/EN, reload, mobile, network error recovery, signup request/rejection, forgot password, non-blocking password banner and password change.');
  } finally {
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await closeDb(db);
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
