const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { once } = require('node:events');

async function run() {
  const { openDb, closeDb } = await import('../server/db.mjs');
  const { createServer } = await import('../server/http.mjs');
  const { seed } = await import('../server/seed.mjs');
  const { MemoryObjectStorage } = await import('./helpers/object-storage.mjs');
  const db = await openDb(':memory:', { driver: 'sqlite' });
  const storage = new MemoryObjectStorage();
  const server = createServer(db, {
    storage, production: false, staticDir: new URL('../app/', require('node:url').pathToFileURL(__filename)).pathname,
  });
  let browser;
  try {
    await seed(db);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'it-IT' });
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const assertFits = async () => assert.equal(await page.evaluate(() => {
      const dialog = document.querySelector('#modal[open]');
      return innerWidth === 390 && document.documentElement.scrollWidth <= innerWidth &&
        (!dialog || dialog.scrollWidth <= dialog.clientWidth + 1);
    }), true);
    const click = command => page.locator(`[data-command="${command}"]`).first().click();

    await page.goto(`http://127.0.0.1:${server.address().port}/#hse`);
    await page.locator('#login-form [name=email]').fill('owner@example.invalid');
    await page.locator('#login-form [name=password]').fill('Local-owner-5b!');
    await page.locator('#login-form [type=submit]').click();
    await page.locator('[data-command=hse-view][data-value=inspections]').click();
    await click('hse-asset-new');
    await page.locator('#hse-asset-form [name=name]').fill('Synthetic lifting station');
    await page.locator('#hse-asset-form [name=templateCode]').selectOption('it_lifting');
    await assertFits();
    await page.locator('#hse-asset-form [type=submit]').click();
    await page.locator('[data-module=hseAssets]').filter({ hasText: 'Synthetic lifting station' }).click();
    await assertFits();

    await click('hse-inspection-new');
    const form = page.locator('#hse-inspection-form');
    const checks = form.locator('[data-inspection-row]');
    await checks.first().waitFor();
    assert.ok(await form.locator('[type=submit]').isDisabled());
    await assertFits();
    const count = await checks.count();
    for (let i = 0; i < count; i++) {
      const button = checks.nth(i).locator(`[data-result=${i === 0 ? 'not_ok' : 'ok'}]`);
      const size = await button.boundingBox();
      assert.ok(size.width >= 44 && size.height >= 44);
      await button.click();
    }
    await form.locator('[data-inspection-note="0"]').fill('Synthetic follow-up');
    assert.equal(await form.locator('[name=outcome]').inputValue(), 'pass_with_notes');
    await form.locator('[type=submit]').click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    await click('hse-inspection-toggle');
    await page.locator('.hse-inspection-items').getByText('Synthetic follow-up').waitFor();
    await assertFits();

    await click('new-attachment');
    await page.locator('#attachment-form [name=file]').setInputFiles({
      name: 'synthetic-condition.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF synthetic mobile inspection'),
    });
    await assertFits();
    await page.locator('#attachment-form [type=submit]').click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    await page.locator('.hse-history').getByText('synthetic-condition.pdf').waitFor();
    await assertFits();
    assert.deepEqual(errors, []);
    console.log('PASS HSE at 390 px: subject, touch targets, checklist, outcome, attachment and history');
  } finally {
    await browser?.close();
    if (server.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await closeDb(db);
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
