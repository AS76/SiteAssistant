const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');

const ORIGIN = 'https://siteassistant.asassi.cloud';
const API_ORIGIN = 'https://api.siteassistant.asassi.cloud';
const STORY = 'C03 night installation';
const CREW = 'Synthetic night crew';
const SECTION = 'C03 night work section';
const IMPEDIMENT = 'C03 access impediment';
const DAY = '2026-11-18T12:00:00.000Z';
const appRoot = path.resolve(__dirname, '../app');

async function hasText(locator, value) {
  const match = locator.filter({ hasText: value });
  await match.waitFor({ state: 'visible' });
  assert.ok((await match.textContent()).includes(value), `Missing text: ${value}`);
}
async function absent(locator) { assert.equal(await locator.count(), 0); }
async function closeModal(page) {
  if (await page.locator('#modal').isVisible()) {
    await page.locator('#modal .modal-header [data-command=close-modal]').click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
  }
}
async function go(page, view) {
  await closeModal(page);
  if (new URL(page.url()).hash === `#${view}`) return;
  // This case exercises the C03 data flow, not every navigation affordance.
  // Change the hash directly so desktop/mobile menus cannot change the route.
  await page.evaluate(next => { location.hash = next; }, view);
  await page.waitForURL(url => url.hash === `#${view}`);
}
async function selectSite(page, site) {
  await page.locator(`#site-select option[value="${site.id}"]`).waitFor({ state: 'attached' });
  await page.selectOption('#site-select', site.id);
  await hasText(page.locator('#topbar-code'), site.code);
  await page.waitForFunction(() => !document.querySelector('#site-select').disabled);
  assert.equal(await page.locator('#site-select').inputValue(), site.id);
}
async function signIn(page, role, site) {
  await page.locator('#login-form [name=email]').fill(`${role}@example.invalid`);
  await page.locator('#login-form [name=password]').fill(`Local-${role}-5b!`);
  await page.locator('#login-form [type=submit]').click();
  await page.locator('#login-form').waitFor({ state: 'detached' });
  await selectSite(page, site);
  const select = page.getByRole('combobox', { name: 'Cantiere', exact: true });
  const label = page.locator('label[for=site-select]');
  assert.equal(await select.getAttribute('id'), 'site-select');
  assert.ok(await label.isVisible());
  await label.click();
  assert.ok(await select.evaluate(node => node === document.activeElement));
  assert.ok((await select.boundingBox()).height >= 44);
}
async function noOverflow(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `Horizontal document overflow at ${page.viewportSize().width}px`);
}

async function setup() {
  const { openDb } = await import('../server/db.mjs');
  const { createServer } = await import('../server/http.mjs');
  const { seed } = await import('../server/seed.mjs');
  const { apply } = await import('../server/seed-demo.mjs');
  const { saveModuleAccess } = await import('../server/module-access.mjs');
  const db = await openDb(':memory:', { driver: 'sqlite' });
  let server, browser;
  try {
    await seed(db, { environment: 'test' });
    // As in browser-wbs: seed-demo owns this overlapping synthetic diary slot.
    await db.run("DELETE FROM diary WHERE site_id IN (SELECT id FROM sites WHERE code = 'FITT-01') AND operational_date = '2026-11-06'");
    await db.transaction(tx => apply(tx));
    const site = await db.get("SELECT * FROM sites WHERE code = 'FITT-03'");
    const owner = await db.get('SELECT id FROM users WHERE email = ?', 'owner@example.invalid');
    for (const role of ['editor', 'verifier']) {
      const member = await db.get('SELECT id FROM users WHERE email = ?', `${role}@example.invalid`);
      await saveModuleAccess(db, { siteId: site.id, memberId: member.id, module: 'workforce_names', allowed: true }, owner);
    }
    const other = await db.get("SELECT * FROM sites WHERE code = 'FITT-05'");
    const task = await db.get('SELECT * FROM tasks WHERE site_id = ? AND title = ?', site.id, STORY);
    const progress = await db.get('SELECT * FROM site_progress_items WHERE site_id = ? AND description = ?', site.id, STORY);
    const deviation = await db.get('SELECT * FROM deviations WHERE site_id = ? AND title = ?', site.id, IMPEDIMENT);
    assert.ok(task && progress && deviation, 'Synthetic C03 story must be seeded');
    assert.equal(task.status, 'blocked');
    assert.equal(task.wbs_id, progress.wbs_id);
    server = createServer(db, { authBypassUser: '', production: false, staticDir: null,
      mailer: async () => { throw new Error('Unexpected mail in synthetic browser test'); },
      storage: {} });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
      headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    return { db, server, browser, site, other, task, progress, deviation,
      apiUrl: `http://127.0.0.1:${server.address().port}` };
  } catch (error) {
    await browser?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await db.close();
    throw error;
  }
}

async function session(env, viewport) {
  // A loaded page can queue diary writes in IndexedDB without a service worker.
  // Blocking workers keeps every request inside this local-only routing boundary;
  // the offline case tests the visible sync path, not shell caching or reload offline.
  const context = await env.browser.newContext({ viewport, serviceWorkers: 'block', locale: 'it-IT', timezoneId: 'UTC' });
  const initial = await context.storageState({ indexedDB: true });
  assert.deepEqual(initial, { cookies: [], origins: [] });
  await context.addInitScript(() => {
    window.c03InitialStorage = { local: localStorage.length, session: sessionStorage.length };
  });
  let disconnected = false;
  const reads = [], errors = [], unexpected = [];
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.setFixedTime(new Date(DAY));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (![ORIGIN, API_ORIGIN].includes(url.origin)) {
      unexpected.push(url.origin);
      return route.abort('blockedbyclient');
    }
    if (url.pathname.startsWith('/api/')) {
      if (disconnected) return route.abort('internetdisconnected');
      // No redirect may leave the loopback backend. Never fetch the requested URL.
      const response = await route.fetch({ url: `${env.apiUrl}${url.pathname}${url.search}`,
        headers: { ...request.headers(), origin: ORIGIN }, maxRedirects: 0 });
      assert.ok(response.status() < 300 || response.status() >= 400, 'Unexpected API redirect');
      if (request.method() === 'GET' && response.ok()) {
        reads.push({ pathname: url.pathname, query: url.searchParams.toString(),
          hash: new URL(page.url()).hash, body: await response.json() });
      }
      return route.fulfill({ response });
    }
    if (url.origin !== ORIGIN) return route.abort('blockedbyclient');
    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    // Explicit local shell allowlist, including self-hosted fonts; all else is aborted.
    const shell = ['index.html', 'app.mjs', 'api.mjs', 'webauthn-client.mjs', 'domain.mjs', 'hse-permissions.mjs',
      'dashboard-layout.mjs', 'offline.mjs', 'i18n.mjs', 'styles.css', 'fonts.css',
      'manifest.webmanifest', 'assets/logo.svg'];
    if (!shell.includes(file) && !/^assets\/fonts\/[a-z0-9-]+\.woff2$/.test(file)) return route.abort('blockedbyclient');
    const contentType = ({ '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript',
      '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' })[path.extname(file)];
    return route.fulfill({ contentType, body: await fs.readFile(path.join(appRoot, file)) });
  });
  await page.goto(`${ORIGIN}/#today`);
  assert.deepEqual(await page.evaluate(() => window.c03InitialStorage), { local: 0, session: 0 });
  return { context, page, reads, errors, unexpected,
    setOffline: async value => { disconnected = value; await context.setOffline(value); },
    check: () => { assert.deepEqual(errors, [], 'Page errors'); assert.deepEqual(unexpected, [], 'External requests'); } };
}

async function openTask(page, env) {
  await go(page, 'tasks');
  const card = page.locator(`[data-command=detail][data-id="${env.task.id}"]`).first();
  if (!(await card.isVisible())) {
    // On phones the board is an accordion and only the first status is open.
    const group = page.locator('.board-status').filter({ has: page.locator(`[data-command=detail][data-id="${env.task.id}"]`) }).first();
    if (await group.count()) await group.locator('summary').click();
  }
  await card.click();
  await hasText(page.locator('#modal'), STORY);
  await hasText(page.locator('#modal .notebook-state'), 'Bloccata');
  await hasText(page.locator('#modal .detail-grid'), SECTION);
  await hasText(page.locator('#modal .detail-grid'), 'C03');
}
async function openWbs(page, env, writable) {
  await go(page, 'wbs');
  await hasText(page.locator('#main .wbs-tree'), SECTION);
  await page.locator(`[data-command=wbs-edit][data-id="${env.task.wbs_id}"]`).click();
  const input = page.locator('#wbs-form [name=description]');
  await input.waitFor({ state: 'visible' });
  assert.equal(await input.inputValue(), SECTION);
  assert.equal(await input.isEditable(), writable);
  assert.equal(await page.locator('#wbs-form fieldset').evaluate(el => el.disabled), !writable);
  await absent(page.locator('[data-wbs-source] input'));
  assert.equal(await page.locator('#wbs-form [type=submit]').count(), writable ? 1 : 0);
}
async function openProgress(page, env) {
  await go(page, 'progress');
  await page.locator(`[data-command=core-detail][data-module=progress][data-id="${env.progress.id}"]`).click();
  await hasText(page.locator('#modal .core-details'), STORY);
  await hasText(page.locator('#modal .core-details'), SECTION);
  assert.equal(await page.locator('#modal progress').getAttribute('value'), '25');
  await hasText(page.locator('#modal .core-progress'), '25%');
  const booked = page.locator('#modal .core-details > div').filter({ has: page.locator('dt', { hasText: 'Ore prenotate in app' }) });
  assert.equal((await booked.locator('dd').textContent()).trim(), '6');
  const planned = page.locator('#progress-hours-form [name=planned_hours]');
  await planned.waitFor({ state: 'visible' });
  assert.equal(await planned.inputValue(), '32');
}
async function setDiaryDate(page, date) {
  const [year, month, day] = date.split('-');
  const display = `${day}/${month}/${year}`;
  await page.locator('#report-date').fill(display);
  await page.locator('#report-date').dispatchEvent('change');
  assert.equal(await page.locator('#report-date').inputValue(), display);
}
async function readDiary(page) {
  await go(page, 'diary');
  await setDiaryDate(page, '2026-11-16');
  const night = page.locator('.diary-entry').filter({ hasText: 'Install C03 section' });
  await hasText(night, 'Turno notturno');
  for (const value of ['Install C03 section', 'C03: six hours booked against the linked progress item',
    'C03 access clearance awaited', 'Resume C03 after clearance']) await hasText(night, value);
}
async function readPath(s, env) {
  const { page, reads } = s;
  assert.equal(new URL(page.url()).hash, '#today');
  const row = page.locator(`[data-command=today-open][data-kind=deviation][data-id="${env.deviation.id}"]`);
  await hasText(page.locator('.today-content'), IMPEDIMENT);
  // Await complete Today resources before opening any module (cold-cache regression).
  await page.waitForFunction(() => document.querySelector('#main').getAttribute('aria-busy') === 'false' &&
    [...document.querySelectorAll('.today-resource-states > p[role=status]')].every(el => !el.textContent.includes('Caricamento')));
  for (const [pathname, id] of [['/api/deviations', env.deviation.id], ['/api/site-progress', env.progress.id], ['/api/tasks', env.task.id]]) {
    assert.ok(reads.some(read => read.pathname === pathname && read.hash === '#today' &&
      Array.isArray(read.body) && read.body.some(item => item.id === id)), `Today did not load ${pathname} with C03`);
  }
  assert.equal(await row.count(), 1);
  await noOverflow(page);
  await row.click();
  await hasText(page.locator('#modal [data-detail-panel=data]'), 'Synthetic access clearance awaited');
  assert.equal(new URL(page.url()).hash, '#today');
  await hasText(page.locator('#modal [data-detail-panel=data]'), 'DEMO-C03');
  await page.locator('[data-command=detail-tab][data-panel=refs]').click();
  // The UI renders linked task IDs as text, rather than task titles or links.
  await hasText(page.locator('#modal [data-detail-panel=refs]'), `Attività: ${env.task.id}`);
  await noOverflow(page);
  await openTask(page, env); await noOverflow(page);
  await openWbs(page, env, true); await noOverflow(page);
  await openProgress(page, env); await noOverflow(page);
  await go(page, 'bookings');
  const booking = page.locator('#main tbody tr').filter({ hasText: STORY });
  await hasText(booking, CREW);
  assert.equal((await booking.locator('td').nth(2).textContent()).trim(), '6,0');
  await noOverflow(page);
  await readDiary(page); await noOverflow(page);
  // No re-selection after reload: assert the actual selected site and story.
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#site-select')?.options.length > 0 && !document.querySelector('#site-select').disabled);
  assert.equal(await page.locator('#site-select').inputValue(), env.site.id, 'Selected site changed after reload');
  await readDiary(page);
  await openTask(page, env);
  await openProgress(page, env);
  await closeModal(page);
  await selectSite(page, env.other);
  await go(page, 'wbs');
  await hasText(page.locator('#main .wbs-tree'), 'Tratta C03 del secondo cantiere');
  assert.ok(!(await page.locator('#main').textContent()).includes(SECTION));
  await absent(page.locator(`[data-command=wbs-edit][data-id="${env.task.wbs_id}"]`));
  await go(page, 'tasks');
  await page.locator('#task-results').waitFor({ state: 'visible' });
  await absent(page.locator(`[data-command=detail][data-id="${env.task.id}"]`));
  assert.ok(!(await page.locator('#main').textContent()).includes(STORY));
  await go(page, 'progress');
  await page.locator('#main[aria-busy=true]').waitFor({ state: 'hidden' });
  await page.locator('#main .core-view').waitFor({ state: 'visible' });
  await absent(page.locator(`[data-command=core-detail][data-id="${env.progress.id}"]`));
  assert.ok(!(await page.locator('#main').textContent()).includes(STORY));
  await go(page, 'diary'); await setDiaryDate(page, '2026-11-16');
  await absent(page.locator('.diary-entry').filter({ hasText: 'Install C03 section' }));
  assert.ok(!(await page.locator('#main').textContent()).includes('C03: six hours'));
  await selectSite(page, env.site);
  await readDiary(page); await openTask(page, env); await openWbs(page, env, true); await openProgress(page, env);
  await noOverflow(page);
}

async function online(env) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const s = await session(env, viewport);
    try {
      await signIn(s.page, 'owner', env.site);
      await readPath(s, env);
      s.check();
    } finally { await s.context.close(); }
  }
  for (const role of ['editor', 'verifier', 'viewer']) {
    const s = await session(env, { width: 1440, height: 900 });
    try {
      await signIn(s.page, role, env.site);
      const writable = role === 'editor';
      await openTask(s.page, env);
      await openWbs(s.page, env, writable);
      await closeModal(s.page);
      assert.equal(await s.page.locator('[data-command=wbs-create]').count(), writable ? 1 : 0);
      if (writable) {
        await s.page.locator('[data-command=wbs-create]').click();
        assert.ok(await s.page.locator('#wbs-form [name=wbs_code]').isEditable());
        assert.ok(await s.page.locator('#wbs-form [name=description]').isEditable());
        await closeModal(s.page);
      }
      await go(s.page, 'bookings');
      const rows = s.page.locator('#main tbody tr');
      if (role === 'viewer') {
        const denied = await s.page.evaluate(async url => {
          const response = await fetch(url, { credentials: 'include' });
          return { status: response.status, code: (await response.json()).code };
        }, `${API_ORIGIN}/api/time-bookings?site_id=${env.site.id}`);
        assert.deepEqual(denied, { status: 403, code: 'MODULE_FORBIDDEN' });
        await s.page.locator('#workforce-summary-form').waitFor({ state: 'visible' });
        await s.page.locator('#main .core-view').waitFor({ state: 'visible' });
        await absent(s.page.locator('#main .core-day'));
        await absent(rows.filter({ hasText: STORY }));
        await absent(rows.filter({ hasText: CREW }));
      } else {
        await hasText(rows.filter({ hasText: STORY }), CREW);
      }
      assert.equal(await s.page.locator('#booking-form').count(), writable ? 1 : 0);
      if (writable) assert.ok(await s.page.locator('#booking-form [name=hours]').isEditable());
      await go(s.page, 'diary'); await setDiaryDate(s.page, '2026-11-16');
      await hasText(s.page.locator('.diary-entry').filter({ hasText: 'Install C03 section' }), 'Turno notturno');
      if (role === 'viewer') await absent(s.page.locator('[data-command=new-entry]'));
      s.check();
    } finally { await s.context.close(); }
  }
  console.log('PASS online: C03 cold Today → deviation/task → WBS → progress → bookings → night diary; reload, site isolation, 1440×900/390×844; named bookings visible to owner/editor/verifier; viewer sees summary and gets 403 MODULE_FORBIDDEN from bookings API');
}

async function pending(page) {
  return page.evaluate(async () => {
    const { listOps } = await import('/offline.mjs');
    return (await listOps()).length;
  });
}
async function until(read, predicate, message) {
  const end = Date.now() + 15000;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < end);
  assert.fail(message);
}
async function offline(env) {
  const s = await session(env, { width: 390, height: 844 });
  const { page } = s;
  const date = '2026-11-17', marker = `C03 offline replay ${randomUUID()}`;
  const plan = `${marker} plan`, actual = `${marker} actual`;
  const rows = () => env.db.all('SELECT * FROM diary WHERE site_id = ? AND operational_date = ? AND shift = ?', env.site.id, date, 'night');
  try {
    await signIn(page, 'editor', env.site);
    await hasText(page.locator('.today-content'), IMPEDIMENT);
    await openTask(page, env); await openWbs(page, env, true); await openProgress(page, env);
    await go(page, 'diary'); await setDiaryDate(page, date);
    assert.equal((await rows()).length, 0, 'Offline diary slot must start empty');
    assert.equal(await pending(page), 0);
    await s.setOffline(true);
    await page.waitForFunction(() => !navigator.onLine);
    await hasText(page.locator('#offline-banner'), 'Offline');
    await page.locator('[data-command=new-entry]').first().click();
    await page.selectOption('#entry-form [name=shift]', 'night');
    await page.locator('#entry-form [name=plan]').fill(plan);
    await page.locator('#entry-form [name=actual]').fill(actual);
    await page.locator('#entry-form [type=submit]').click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    const local = page.locator('.diary-entry').filter({ hasText: plan });
    await hasText(local, actual); await hasText(local, 'Turno notturno');
    await hasText(local.locator('.sync-pending'), 'in attesa di sync');
    await hasText(page.locator('#offline-banner'), '1 in attesa di sync');
    assert.equal(await pending(page), 1);
    assert.equal((await rows()).length, 0, 'Offline write reached SQLite');
    await s.setOffline(false); // The real online event invokes the app's syncQueue.
    await page.waitForFunction(() => navigator.onLine);
    const saved = await until(rows, value => value.length > 0, 'Diary did not replay to SQLite');
    assert.equal(saved.length, 1); assert.equal(saved[0].plan, plan); assert.equal(saved[0].actual, actual);
    await until(() => pending(page), value => value === 0, 'Pending queue did not drain');
    await hasText(page.locator('.diary-entry').filter({ hasText: plan }), actual);
    await page.locator('.diary-entry').filter({ hasText: plan }).locator('[class*=sync-]').waitFor({ state: 'hidden' });
    await page.locator('#offline-banner [data-command=sync-now]').waitFor({ state: 'hidden' });
    // Trigger a second natural sync and wait for its UI load to finish; no duplicate.
    await s.setOffline(true); await page.waitForFunction(() => !navigator.onLine);
    const diaryReads = s.reads.filter(read => read.pathname === '/api/diary').length;
    await s.setOffline(false);
    await until(() => s.reads.filter(read => read.pathname === '/api/diary').length,
      count => count > diaryReads, 'Second online event did not refresh diary');
    await page.waitForFunction(() => navigator.onLine && !document.querySelector('#site-select').disabled);
    await until(() => pending(page), value => value === 0, 'Queue returned after second sync');
    assert.equal((await rows()).length, 1, 'Replay duplicated the diary slot');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#site-select')?.options.length > 0 && !document.querySelector('#site-select').disabled);
    assert.equal(await page.locator('#site-select').inputValue(), env.site.id);
    await go(page, 'diary'); await setDiaryDate(page, date);
    await hasText(page.locator('.diary-entry').filter({ hasText: plan }), actual);
    assert.equal((await rows()).length, 1);
    assert.equal(await pending(page), 0);
    await s.setOffline(true);
    const scope = await page.evaluate(async () => {
      const { getMirror, enqueue } = await import('/offline.mjs');
      const { scope } = await getMirror('active');
      await enqueue({ scope, op_type: 'create_task', payload: { title: 'Discarded at sign-out' } });
      return scope;
    });
    await page.locator('#logout').click();
    await page.locator('#login-form').waitFor();
    assert.deepEqual(await page.evaluate(async scope => {
      const { getMirror, listOps } = await import('/offline.mjs');
      return [(await getMirror(`state:${scope}`)) ?? null, (await getMirror('active')) ?? null, (await listOps(scope)).length];
    }, scope), [null, null, 0]);
    const revocation = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/logout');
    await s.setOffline(false);
    assert.equal((await revocation).status(), 200);
    await page.reload();
    await page.locator('#login-form').waitFor();
    assert.equal((await env.db.get("SELECT count(*) AS count FROM tasks WHERE title = 'Discarded at sign-out'")).count, 0);
    s.check();
    console.log('PASS offline: C03 diary replays once, sign-out purges IndexedDB and reconnect revokes the session');
  } finally { await s.context.close(); }
}

async function run() {
  const args = process.argv.slice(2);
  assert.ok(args.length <= 1 && (!args.length || ['--case=online', '--case=offline'].includes(args[0])),
    'Usage: node tests/browser-c03.cjs [--case=online|--case=offline]');
  const selected = args[0]?.slice('--case='.length) || 'online';
  const env = await setup();
  try { await ({ online, offline })[selected](env); }
  finally {
    await env.browser.close();
    await new Promise(resolve => env.server.close(resolve));
    await env.db.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
