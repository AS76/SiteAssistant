const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { join } = require('node:path');

async function run() {
  const { openDb, closeDb } = await import('../server/db.mjs');
  const { createServer } = await import('../server/http.mjs');
  const { seed } = await import('../server/seed.mjs');
  const db = await openDb(':memory:', { driver: 'sqlite' });
  const server = createServer(db, { production: false, staticDir: join(__dirname, '../app') });
  let browser;
  try {
    await seed(db);
    await db.run("UPDATE users SET password_change_required = TRUE WHERE email = 'owner@example.invalid'");
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(() => {
      window.policyViolations = [];
      document.addEventListener('securitypolicyviolation', event => policyViolations.push(event.violatedDirective));
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    const shell = await page.goto(`${base}/#tasks`);
    assert.match((await shell.allHeaders())['content-security-policy'], /worker-src 'self'/);
    await page.locator('#login-form [name=email]').fill('owner@example.invalid');
    await page.locator('#login-form [name=password]').fill('Local-owner-5b!');
    await page.locator('#login-form [type=submit]').click();
    const gate = page.locator('#password-banner');
    await gate.waitFor();
    const denied = await context.request.get(`${base}/api/tasks`);
    assert.equal(denied.status(), 403);
    assert.equal((await denied.json()).code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal(await page.locator('#navigation').isVisible(), false);
    assert.equal(await page.locator('#task-results').count(), 0);

    await gate.locator('[data-command=change-password]').click();
    const password = page.locator('#password-form');
    await password.locator('[name=current_password]').fill('Local-owner-5b!');
    await password.locator('[name=new_password]').fill('Different-synthetic-password');
    await password.locator('[name=confirm_password]').fill('Different-synthetic-password');
    await password.locator('[type=submit]').click();
    await gate.waitFor({ state: 'hidden' });
    await page.locator('#task-results').waitFor();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    assert.equal(await page.evaluate(async () => Boolean(await caches.match('/manifest.webmanifest'))), true);
    assert.deepEqual(await page.evaluate(() => policyViolations), []);
    await context.setOffline(true);
    await page.reload();
    await page.locator('#task-results').waitFor();
    assert.deepEqual(await page.evaluate(() => policyViolations), []);
    assert.deepEqual(errors, []);
    console.log('PASS temporary password screen, server gate, service worker precache and offline PWA under CSP');
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
