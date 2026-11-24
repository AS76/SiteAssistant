const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');

// All requests are fulfilled locally. Every DB and credential is synthetic.
async function run() {
  const { openDb } = await import('../server/db.mjs');
  const { createServer } = await import('../server/http.mjs');
  const { seed } = await import('../server/seed.mjs');
  const { apply } = await import('../server/seed-demo.mjs');
  const { wbsSource, attachSyntheticIngestion } = await import('./helpers/wbs.mjs');
  const { importWbs } = await import('../server/wbs.mjs');
  const db = await openDb(':memory:', { driver: 'sqlite' });
  let browser, server;
  try {
    await seed(db);
    // Keep the login fixture; the demo seed owns diaries for this site/date.
    await db.run("DELETE FROM diary WHERE site_id IN (SELECT id FROM sites WHERE code = 'FITT-01') AND operational_date = '2026-11-06'");
    await db.transaction(tx => apply(tx)); await attachSyntheticIngestion(db);
    const site = await db.get("SELECT * FROM sites WHERE code = 'FITT-03'");
    const other = await db.get("SELECT * FROM sites WHERE code = 'FITT-05'");
    const owner = await db.get("SELECT * FROM users WHERE email = 'owner@example.invalid'");
    const source = await wbsSource(db, site, [{ wbs_code: 'C03', level: 0, description: 'Synthetic source C03' }]);
    await importWbs(db, site.id, owner);
    const c03 = await db.get("SELECT * FROM project_structure WHERE site_id = ? AND wbs_code = 'C03'", site.id);
    server = createServer(db); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    let flows = 0;
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const apiUrl = `http://127.0.0.1:${server.address().port}`;
      // The shell uses its existing API base; interception keeps it off the network.
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.pathname.startsWith('/api/')) {
          const response = await route.fetch({ url: `${apiUrl}${url.pathname}${url.search}`, headers: { ...request.headers(), origin: 'https://siteassistant.asassi.cloud' } });
          return route.fulfill({ response });
        }
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (!['index.html', 'app.mjs', 'api.mjs', 'webauthn-client.mjs', 'domain.mjs', 'hse-permissions.mjs', 'dashboard-layout.mjs', 'offline.mjs', 'i18n.mjs', 'styles.css'].includes(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript', body: await fs.readFile(path.join(__dirname, '../app', file)) });
      });
      const signIn = async role => {
        await page.locator('#login-form [name=email]').fill(`${role}@example.invalid`);
        await page.locator('#login-form [name=password]').fill(`Local-${role}-5b!`);
        await page.locator('#login-form [type=submit]').click(); await page.locator('#login-form').waitFor({ state: 'detached' });
        await page.selectOption('#site-select', site.id);
      };
      const go = async view => {
        if (new URL(page.url()).hash === `#${view}`) return;
        const direct = page.locator(`#navigation a[href="#${view}"]`);
        if (await direct.isVisible()) await direct.click();
        else {
          const more = page.locator('[data-command=more-nav]');
          if (await more.isVisible()) {
            await more.click();
            await page.locator(`.more-nav a[href="#${view}"]`).click();
          } else {
            await page.locator('.nav-group').filter({ has: direct }).locator('summary').click();
            await direct.click();
          }
        }
        await page.waitForURL(url => url.hash === `#${view}`);
        await page.locator('#modal').waitFor({ state: 'hidden' });
      };
      const save = async id => { await page.locator(`#${id} [type=submit]`).click(); await page.locator(`#${id}`).waitFor({ state: 'hidden' }); };
      await page.goto('https://siteassistant.asassi.cloud'); await signIn('owner'); await go('wbs');
      await page.locator('[data-command=wbs-create]').click(); await page.locator('#wbs-form [name=wbs_code]').fill(`SYN-${width}`);
      await page.locator('#wbs-form [name=description]').fill(`Synthetic browser section ${width}`); await save('wbs-form');
      const created = await db.get('SELECT * FROM project_structure WHERE site_id = ? AND wbs_code = ?', site.id, `SYN-${width}`); assert.ok(created);
      await page.locator(`[data-command=wbs-edit][data-id="${c03.id}"]`).first().click();
      assert.equal(await page.locator('[data-wbs-source] input').count(), 0);
      await page.locator('#wbs-form [name=description]').fill(`Local C03 ${width}`);
      await page.locator('#wbs-form [name=parent_id]').selectOption(created.id);
      await page.locator('#wbs-form [name=sort_order]').fill('0'); await save('wbs-form');
      await wbsSource(db, site, [{ ...source.rows[0], description: `Changed source C03 ${width}` }], { scopeId: source.scopeId }); await importWbs(db, site.id, owner);
      await page.locator('[data-command=wbs-reload]').click();
      await page.locator(`[data-command=wbs-edit][data-id="${c03.id}"]`).first().click();
      assert.match(await page.locator('#wbs-form [role=alert]').last().textContent(), /fonte|source/i);
      assert.equal(await page.locator('#wbs-form [name=description]').inputValue(), `Local C03 ${width}`);
      await page.locator('#wbs-form [name=resolve_description]').selectOption('keep'); await save('wbs-form');
      // Archive and restore a native node; linked imported C03 remains readable.
      await page.locator(`[data-command=wbs-edit][data-id="${created.id}"]`).first().click();
      await page.locator('#wbs-form [name=archived]').check(); await save('wbs-form');
      assert.ok((await db.get('SELECT archived_at FROM project_structure WHERE id = ?', created.id)).archived_at);
      await page.locator('[data-command=wbs-view][data-value=flat]').click();
      assert.ok((await page.locator('#main').textContent()).includes(`Local C03 ${width}`));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await go('tasks'); await page.locator('[data-command=new-task]').click();
      await page.locator('#task-form [name=title]').fill(`Synthetic assigned work ${width}`);
      await page.locator('#task-form [name=wbsId] option').filter({ hasText: 'C03' }).waitFor({ state: 'attached' });
      await page.locator('#task-form [name=wbsId]').selectOption(c03.id);
      assert.equal(await page.locator('#task-form [name=wbsId] option[value=""]').textContent(), 'WBS da collegare');
      await page.locator('#executor-account').selectOption('other'); await page.locator('#task-form [name=assignee]').fill('Synthetic crew');
      await page.locator('#verifier-account').selectOption('other'); await page.locator('#task-form [name=reviewer]').fill('Synthetic checker'); await save('task-form');
      const task = await db.get('SELECT * FROM tasks WHERE title = ?', `Synthetic assigned work ${width}`); assert.equal(task.wbs_id, c03.id);
      await page.locator(`[data-command=detail][data-id="${task.id}"]`).first().click();
      await page.locator('#modal').filter({ hasText: `Local C03 ${width}` }).waitFor({ state: 'visible' });
      assert.ok((await page.locator('#modal').textContent()).includes(`Local C03 ${width}`));
      await page.locator('[data-command=task-wbs]').click(); await page.locator('#task-wbs-form [name=wbsId]').selectOption(''); await save('task-wbs-form');
      assert.equal((await db.get('SELECT wbs_id FROM tasks WHERE id = ?', task.id)).wbs_id, null);
      await page.selectOption('#site-select', other.id); await go('wbs');
      await page.locator('[data-command=wbs-edit]').first().waitFor();
      assert.equal(await page.locator(`[data-command=wbs-edit][data-id="${c03.id}"]`).count(), 0);
      assert.ok((await page.locator('#main').textContent()).includes('C03'));
      await page.locator('#language').click(); assert.ok((await page.locator('#main').textContent()).includes('Create node'));
      await page.locator('[data-command=logout]').click(); await signIn('viewer'); await go('wbs');
      await page.locator('[data-command=wbs-edit]').first().waitFor();
      assert.equal(await page.locator('[data-command=wbs-create]').count(), 0);
      await page.locator(`[data-command=wbs-edit][data-id="${c03.id}"]`).first().click();
      await page.locator('#wbs-form [name=description]').waitFor({ state: 'visible' });
      assert.ok(await page.locator('#wbs-form fieldset').evaluate(element => element.disabled));
      assert.ok(await page.locator('#wbs-form [name=description]').isDisabled());
      await page.locator('#modal .modal-header [data-command=close-modal]').click();
      await page.locator('[data-command=logout]').click(); await signIn('editor'); await go('wbs');
      await page.locator('[data-command=wbs-create]').waitFor();
      await page.screenshot({ path: `/tmp/siteassistant-wbs-${width}.png`, fullPage: true });
      assert.deepEqual(errors, []);
      await context.close(); flows++;
    }
    console.log(`PASS: ${flows} browser flows (1440/390), IT/EN, owner/editor/viewer, native CRUD, source conflict, task link, site isolation`);
  } finally {
    await browser?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await db.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
