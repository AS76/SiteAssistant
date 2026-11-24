const assert = require('node:assert/strict');
const { once } = require('node:events');
const { join } = require('node:path');
const { chromium } = require('playwright');

async function checkNoPageOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}

async function checkFieldSize(container) {
  const sizes = await container.locator('input:visible, select:visible, textarea:visible').evaluateAll(
    fields => fields.map(field => parseFloat(getComputedStyle(field).fontSize)).filter(Number.isFinite),
  );
  assert.ok(sizes.length > 0);
  assert.ok(sizes.every(size => size >= 16), `Mobile field sizes: ${sizes.join(', ')}`);
}

async function checkMobile(browser, base, width) {
  const viewport = { width, height: 812 };
  const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    const login = page.locator('#login-form');
    await login.waitFor();
    await checkFieldSize(login);
    await login.locator('[name=email]').fill('owner@example.invalid');
    await login.locator('[name=password]').fill('Local-owner-5b!');
    await login.locator('[type=submit]').tap();
    const navigation = page.locator('#navigation');
    const tasks = navigation.locator('a[href="#tasks"]');
    await tasks.waitFor();
    await checkNoPageOverflow(page);
    await navigation.locator('[data-command=more-nav]').tap();
    const dialog = page.locator('#modal');
    await dialog.locator('.more-nav a[href="#sites"]').waitFor();
    await dialog.locator('.modal-header [data-command=close-modal]').tap();
    await tasks.tap();
    await page.locator('#task-results').waitFor();
    await page.locator('[data-command=task-view][data-value=list]').tap();
    const table = page.locator('#task-results .table-scroll');
    await table.locator('tbody tr').first().waitFor();
    await checkNoPageOverflow(page);
    assert.equal(await table.evaluate(element => {
      const left = element.scrollLeft;
      element.scrollLeft = element.scrollWidth;
      const scrolled = element.scrollLeft > left;
      element.scrollLeft = left;
      return scrolled;
    }), true);
    await checkFieldSize(page.locator('.notebook-tools'));
    await checkFieldSize(page.locator('.site-control'));

    const cdp = await context.newCDPSession(page);
    // Chromium desktop cannot synthesize a reliable pinch through CDP. Verify
    // the page accepts a changed visual scale and keep real pinch testing for
    // the Safari/iOS pass.
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.7 });
    await page.waitForFunction(() => visualViewport.scale > 1.2);
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });

    await page.locator('[data-command=new-task]').tap();
    const form = page.locator('#task-form');
    await form.waitFor();
    await checkFieldSize(form);
    // Chromium headless has no system keyboard. Reduce the viewport to exercise
    // focusing, scrolling and submitting with similar vertical space.
    await page.setViewportSize({ width, height: 330 });
    const title = form.locator('[name=title]');
    await title.focus();
    await page.keyboard.type(`Synthetic mobile task ${width}`);
    assert.equal(await title.inputValue(), `Synthetic mobile task ${width}`);
    assert.equal(await page.evaluate(() => visualViewport.scale), 1);
    await checkNoPageOverflow(page);
    const cancel = form.locator('[data-command=close-modal]');
    await cancel.scrollIntoViewIfNeeded();
    assert.ok((await cancel.boundingBox()).y >= 0);
    await cancel.tap();
    await dialog.waitFor({ state: 'hidden' });
    await page.setViewportSize(viewport);
    assert.deepEqual(errors, []);
    console.log(`PASS mobile Chromium ${width}px: navigation, table scroll, page scale and form at reduced height`);
  } finally {
    await context.close();
  }
}

async function run() {
  const { openDb, closeDb } = await import('../server/db.mjs');
  const { createServer } = await import('../server/http.mjs');
  const { seed } = await import('../server/seed.mjs');
  const db = await openDb(':memory:', { driver: 'sqlite' });
  const server = createServer(db, { production: false, staticDir: join(__dirname, '../app') });
  let browser;
  try {
    await seed(db, { environment: 'test' });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    browser = await chromium.launch({
      headless: !process.env.HEADFUL,
      executablePath: process.env.CHROMIUM_PATH || undefined,
    });
    for (const width of [320, 390]) await checkMobile(browser, `http://127.0.0.1:${server.address().port}`, width);
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
