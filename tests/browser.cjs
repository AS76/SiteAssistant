const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = process.env.SITEASSISTANT_URL || 'http://127.0.0.1:8000';
    page.on('request', request => { if (!request.url().startsWith(url) && !request.url().startsWith('data:')) external.push(request.url()); });
    await page.goto(url);
    await page.waitForSelector('[data-metric="execution"]');
    assert.equal(await page.locator('[data-metric="review"]').textContent(), '1');
    await page.screenshot({ path: path.join(os.tmpdir(), 'siteassistant-desktop.png'), fullPage: true });

    await page.locator('a[href="#tasks"]').first().click();
    await page.getByRole('button', { name: 'Nuova attività', exact: true }).click();
    await page.locator('[name="title"]').fill('Synthetic workflow task');
    await page.locator('[name="company"]').fill('Demo company');
    await page.locator('[name="area"]').fill('Area TEST');
    await page.locator('[name="criteria"]').fill('Documented result');
    await page.locator('[name="reviewer"]').selectOption('worker');
    await page.getByRole('button', { name: 'Salva', exact: true }).click();
    assert.match(await page.locator('.form-error').textContent(), /persone diverse/);
    await page.locator('[name="reviewer"]').selectOption('reviewer');
    await page.getByRole('button', { name: 'Salva', exact: true }).click();
    await page.locator('#filter-search').fill('Synthetic workflow');
    assert.equal(await page.locator('.task-card').count(), 1);
    await page.locator('.task-card').click();
    await page.getByRole('button', { name: 'Avvia', exact: true }).click();
    await page.locator('#detail-actor').selectOption('worker');
    await page.getByRole('button', { name: 'Segnala blocco', exact: true }).click();
    await page.locator('[name="note"]').fill('Waiting for demo material; next step: confirm delivery.');
    await page.getByRole('button', { name: 'Segnala blocco', exact: true }).click();
    await page.getByRole('button', { name: 'Riprendi', exact: true }).click();
    await page.getByRole('button', { name: 'Dichiara eseguita', exact: true }).click();
    await page.locator('[name="note"]').fill('Evidence DEMO-01');
    await page.getByRole('button', { name: 'Dichiara eseguita', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Verifica e chiudi', exact: true }).count(), 0);
    await page.locator('#detail-actor').selectOption('reviewer');
    await page.getByRole('button', { name: 'Verifica e chiudi', exact: true }).click();
    await page.locator('[name="note"]').fill('Checked against criteria.');
    await page.getByRole('button', { name: 'Verifica e chiudi', exact: true }).click();
    assert.equal(await page.locator('.modal-body > p .badge.closed').count(), 1);
    assert.match(await page.locator('.timeline').textContent(), /Evidence DEMO-01/);
    await page.getByRole('button', { name: 'Riapri', exact: true }).click();
    await page.locator('[name="note"]').fill('Follow-up correction required.');
    await page.getByRole('button', { name: 'Riapri', exact: true }).click();
    assert.equal(await page.locator('.modal-body > p .badge.active').count(), 1);
    assert.match(await page.locator('.timeline').textContent(), /Checked against criteria/);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Elenco', exact: true }).click();
    const csvEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Esporta CSV', exact: true }).click();
    const csv = await csvEvent;
    assert.match(await fs.readFile(await csv.path(), 'utf8'), /Synthetic workflow task/);

    await page.locator('a[href="#diary"]').first().click();
    await page.locator('#report-date').fill('2026-01-10');
    await page.locator('#report-date').dispatchEvent('change');
    await page.getByRole('button', { name: 'Aggiungi contributo', exact: true }).first().click();
    await page.locator('[name="shift"]').selectOption('night');
    await page.locator('[name="plan"]').fill('Test night plan');
    await page.locator('[name="actual"]').fill('<img src=x onerror="window.demoXss=true">');
    await page.locator('[name="next"]').fill('Test handover');
    await page.getByRole('button', { name: 'Salva', exact: true }).click();
    assert.equal(await page.locator('.diary-entry').count(), 1);
    assert.match(await page.locator('.diary-entry').textContent(), /Turno notturno/);
    assert.equal(await page.locator('.diary-entry img').count(), 0);
    assert.equal(await page.evaluate(() => window.demoXss), undefined);

    await page.locator('#language').click();
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.match(await page.locator('h1').textContent(), /record/);
    assert.match(await page.locator('.diary-entry').textContent(), /Night shift/);
    assert.match(await page.locator('.diary-entry').textContent(), /Test night plan/);

    await page.locator('a[href="#sites"]').first().click();
    await page.getByRole('button', { name: 'New site', exact: true }).click();
    await page.locator('[name="code"]').fill('TEST-03');
    await page.locator('[name="name"]').fill('Synthetic site');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('a[href="#tasks"]').first().click();
    assert.equal(await page.locator('.task-card').count(), 0);
    assert.match(await page.locator('#task-results').textContent(), /No results/);
    await page.reload();
    await page.waitForSelector('#site-select');
    assert.equal(await page.locator('#site-select option:checked').textContent(), 'Synthetic site');
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');

    const downloadEvent = page.waitForEvent('download');
    await page.locator('#backup').click();
    const backup = await downloadEvent;
    const backupText = await fs.readFile(await backup.path(), 'utf8');
    const backupData = JSON.parse(backupText);
    assert.equal(backupData.tasks.some(task => task.title === 'Synthetic workflow task'), true);
    await page.locator('#restore-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"schemaVersion":99}') });
    assert.equal(await page.locator('#site-select option').count(), 3);
    await page.locator('#reset').click();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    assert.equal(await page.locator('#site-select option').count(), 2);
    await page.locator('#restore-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backupText) });
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    assert.equal(await page.locator('#site-select option').count(), 3);

    await page.setViewportSize({ width: 390, height: 844 });
    for (const view of ['overview', 'sites', 'tasks', 'diary']) {
      await page.locator(`a[href="#${view}"]`).first().click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `mobile overflow: ${view}`);
    }
    await page.locator('h1').click();
    await page.screenshot({ path: path.join(os.tmpdir(), 'siteassistant-mobile.png'), fullPage: true });

    await page.locator('a[href="#tasks"]').first().click();
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    await page.locator('[name="title"]').fill('Unsaved cross-tab text');
    await page.locator('[name="company"]').fill('Example');
    await page.locator('[name="criteria"]').fill('Check');
    const otherPage = await context.newPage();
    await otherPage.goto(url);
    await otherPage.waitForSelector('#site-select');
    await otherPage.locator('a[href="#sites"]').first().click();
    await otherPage.getByRole('button', { name: 'New site', exact: true }).click();
    await otherPage.locator('[name="code"]').fill('TEST-04');
    await otherPage.locator('[name="name"]').fill('Concurrent demo site');
    await otherPage.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    assert.match(await page.locator('.form-error').textContent(), /another tab/);
    assert.equal(await page.locator('[name="title"]').inputValue(), 'Unsaved cross-tab text');
    await otherPage.close();
    await page.reload();
    await page.waitForSelector('#site-select');

    await page.locator('a[href="#tasks"]').first().click();
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    await page.locator('[name="title"]').fill('Unsaved persistence test');
    await page.locator('[name="company"]').fill('Example');
    await page.locator('[name="criteria"]').fill('Check');
    await page.evaluate(() => { Storage.prototype.setItem = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }; });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    assert.match(await page.locator('.form-error').textContent(), /Save failed/);
    assert.equal(await page.locator('[name="title"]').inputValue(), 'Unsaved persistence test');
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log('PASS: creation, role separation, block/resume, evidence, verification, reopening/history, filters, CSV, night diary, escaping, IT/EN, site isolation, persistence, backup/restore, mobile layout and save-error recovery.');
    await context.close();
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
