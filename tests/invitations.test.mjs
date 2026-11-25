import test from 'node:test';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createServer } from '../server/http.mjs';
import { tokenHash } from '../server/auth.mjs';
import { changePermission, INVITATION_PERMISSION } from '../server/admin.mjs';
import { createInvitation, listInvitations, reissueInvitation, retryInvitation, revokeInvitation } from '../server/invitations.mjs';
import { createUser } from '../server/create-user.mjs';
import { createSmtpMailer } from '../server/auth-mail.mjs';
import { createSite } from '../server/repository.mjs';
import { openTestDb } from './helpers/db.mjs';
import { requestListener } from './helpers/auth.mjs';
import { database } from './helpers/procurement.mjs';

const email = 'invitee@example.invalid';
const adminEmail = 'administrator@example.invalid';
const password = 'Synthetic-chosen-password!';
const publicUrl = 'https://invite.example.invalid';
const invitations = '/api/admin/invitations';

async function fixture(t, options = {}, db) {
  if (!db) {
    const opened = await openTestDb();
    t.after(opened.close);
    db = opened.db;
  }
  const mail = [];
  const request = requestListener(createServer(db, {
    mailer: async message => { mail.push(message); }, publicUrl, ...options,
  }));
  const post = (path, body, options = {}) => request(path, { method: 'POST', body, ...options });
  const login = (email, password) => post('/api/auth/login', { email, password });
  const createAccount = email => createUser(db, { email, name: 'Synthetic user', password });
  const admin = await createAccount(adminEmail);
  const permission = (action, address = adminEmail) => changePermission(db, action, INVITATION_PERMISSION, address);
  await permission('grant');
  const cookie = (await login(adminEmail, password)).headers['set-cookie'].split(';')[0];
  const invite = (email, options, fields) => post(invitations, { email, ...fields }, { cookie, ...options });
  const revoke = (id, options) => post(`${invitations}/${id}/revoke`, undefined, { cookie, ...options });
  const activate = (token, chosen = password, options) => post('/api/auth/activate', { token, password: chosen }, options);
  const form = (token, confirmation, site = 'same-origin', userAgent = 'Desktop browser') => request('/api/auth/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': site, 'user-agent': userAgent },
    rawBody: new URLSearchParams({ token, password, confirmation }).toString(),
  });
  const users = () => db.all('SELECT id FROM users WHERE lower(email) = ?', email);
  return { db, mail, admin, request, invite, revoke, activate, form, login, users, createAccount, permission };
}

function link(message) {
  return new URL(message.text.match(/^https:\/\/\S+$/m)[0]);
}

async function issued(t, f, fields) {
  const response = await f.invite(' INVITEE@EXAMPLE.INVALID ', undefined, fields);
  t.assert.strictEqual(response.status, 201);
  const message = f.mail.at(-1);
  const url = link(message);
  return { id: response.body.id, response, message, token: url.searchParams.get('token'), url };
}

async function submitActivationPage(t, f, page, url, userAgent) {
  const script = page.body.match(/<script>([\s\S]+)<\/script>/)[1];
  const hash = createHash('sha256').update(script).digest('base64');
  t.assert.ok(page.headers['content-security-policy'].includes(`'sha256-${hash}'`));
  let onSubmit, response, redirect;
  const form = { action: '/api/auth/activate', querySelector: () => ({}), addEventListener: (_, listener) => { onSubmit = listener; } };
  const sessionStorage = new Map();
  runInNewContext(script, {
    document: { querySelector: selector => selector === 'form' ? form : {} },
    location: { href: url.href, replace: target => { redirect = target; } },
    sessionStorage: { setItem: (...args) => sessionStorage.set(...args) },
    FormData: function () { return [['password', password], ['confirmation', password]]; },
    URL, URLSearchParams,
    fetch: async (path, { method, body, redirect: mode }) => {
      t.assert.strictEqual(mode, 'manual');
      response = await f.request(path, {
        method, rawBody: body.toString(),
        headers: {
          'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', 'user-agent': userAgent,
        },
      });
      return { type: response.status === 303 ? 'opaqueredirect' : 'basic' };
    },
  });
  await onSubmit({ preventDefault() {} });
  t.assert.strictEqual(redirect, '/');
  t.assert.strictEqual(sessionStorage.get('sa-activated'), '1');
  return response;
}

async function verifyRoundTrip(t, f) {
  const { id, response, message, token, url } = await issued(t, f, { locale: ' IT ' });
  t.assert.strictEqual(f.mail.length, 1);
  t.assert.strictEqual(message.subject, 'Il tuo invito a SiteAssistant');
  t.assert.strictEqual(message.to, email);
  t.assert.match(message.html, /<html lang="it">/);
  t.assert.match(message.text, /72 ore/);
  t.assert.match(message.text, /nessuno te la chiederà via email/);
  t.assert.ok(!message.text.includes(password) && !message.html.includes(password));
  t.assert.strictEqual(url.origin, publicUrl);
  t.assert.strictEqual(url.pathname, '/attiva');
  t.assert.ok(/^[A-Za-z0-9_-]{43}$/.test(token));
  const row = await f.db.get('SELECT * FROM invitations WHERE id = ?', id);
  t.assert.strictEqual(row.email, email);
  t.assert.strictEqual(row.created_by, f.admin.id);
  t.assert.strictEqual(row.locale, 'it');
  t.assert.strictEqual(row.delivery_status, 'sent');
  t.assert.strictEqual(row.delivery_attempts, 1);
  t.assert.ok(row.delivered_at);
  t.assert.strictEqual(Date.parse(row.expires_at) - Date.parse(row.created_at), 72 * 3600 * 1000);
  t.assert.ok(row.token_hash === tokenHash(token) && !JSON.stringify([row, response.body]).includes(token));
  t.assert.deepStrictEqual(await f.users(), []);
  const result = await f.activate(token);
  t.assert.strictEqual(result.status, 200);
  t.assert.match(result.headers['set-cookie'], /; Path=\/api; HttpOnly; SameSite=Lax/);
  const cookie = result.headers['set-cookie'].split(';')[0];
  const me = await f.request('/api/auth/me', { cookie });
  t.assert.strictEqual(me.status, 200);
  t.assert.strictEqual(me.body.user.email, email);
  t.assert.strictEqual(me.body.user.language, 'it');
  t.assert.deepStrictEqual((await f.request('/api/sites', { cookie })).body, []);
  t.assert.strictEqual(me.body.password_change_required, false);
  t.assert.deepStrictEqual(me.body.roles, []);
  t.assert.strictEqual((await f.activate(token)).status, 410);
  t.assert.strictEqual((await f.users()).length, 1);
  const events = await f.db.all("SELECT user_id, event, detail_json FROM auth_events WHERE event LIKE 'invitation_%' ORDER BY event");
  t.assert.deepStrictEqual(events.map(e => [e.event, e.user_id, JSON.parse(e.detail_json)]), [
    ['invitation_created', f.admin.id, { invitation_id: id }],
    ['invitation_delivered', f.admin.id, { invitation_id: id, attempt: 1 }],
    ['invitation_used', result.body.user.id, { invitation_id: id }],
  ]);
  t.assert.ok(!JSON.stringify(events).includes(token));
}

test('invitation emails contain a 72-hour link and activation creates exactly one account and session', async t => {
  await verifyRoundTrip(t, await fixture(t));
});

test('PostgreSQL migration and invitation round trip work in PGlite', async t => {
  const db = await database(t, 'pg');
  const f = await fixture(t, {}, db);
  await verifyRoundTrip(t, f);
  const site = await createSite(db, { code: 'INVITE-PG', name: 'Synthetic PostgreSQL site' });
  await db.run("INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, 'owner')", site.id, f.admin.id);
  const address = 'pg-invite@example.invalid';
  const failure = await createInvitation(db, address, f.admin.id, {
    publicUrl, cantiere_id: site.id, role: 'viewer',
    mailer: async () => { throw new Error('Synthetic delivery failure'); },
  });
  t.assert.strictEqual(failure.delivery_status, 'failed');
  const sent = [];
  const options = { publicUrl, mailer: async message => { sent.push(message); } };
  const retried = await retryInvitation(db, failure.id, options);
  t.assert.strictEqual(retried.delivery_attempts, 2);
  const replacement = await reissueInvitation(db, address, options);
  t.assert.strictEqual(replacement.delivery_status, 'sent');
  t.assert.strictEqual((await f.activate(link(sent[0]).searchParams.get('token'))).status, 410);
  const token = link(sent[1]).searchParams.get('token');
  const activated = await Promise.all([f.activate(token), f.activate(token)]);
  t.assert.deepStrictEqual(activated.map(result => result.status).sort(), [200, 410]);
  const user = activated.find(result => result.status === 200).body.user;
  t.assert.strictEqual((await db.get('SELECT role FROM site_members WHERE user_id = ?', user.id)).role, 'viewer');
  t.assert.strictEqual((await f.permission('revoke')).active, false);
  t.assert.strictEqual((await f.invite(address)).status, 403);
});

test('expired invitations return the generic 410 and can be replaced', async t => {
  const f = await fixture(t);
  const { id, token, url } = await issued(t, f);
  await f.db.run('UPDATE invitations SET expires_at = created_at WHERE id = ?', id);
  const expired = await f.activate(token);
  t.assert.strictEqual(expired.status, 410);
  t.assert.deepStrictEqual(expired, await f.activate('A'.repeat(43)));
  t.assert.deepStrictEqual(await f.users(), []);
  const page = await f.request(url.pathname + url.search);
  t.assert.strictEqual(page.status, 410);
  t.assert.match(page.body, /Ask your administrator for a new invitation/);
  t.assert.ok(!page.body.includes(token));
  t.assert.strictEqual((await f.invite(email)).status, 201);
  t.assert.ok((await f.db.get('SELECT revoked_at FROM invitations WHERE id = ?', id)).revoked_at);
});

test('revocation invalidates both the link and activation and is audited', async t => {
  const f = await fixture(t);
  const { id, token, url } = await issued(t, f);
  t.assert.strictEqual((await f.revoke(id)).status, 200);
  t.assert.strictEqual((await f.activate(token)).status, 410);
  t.assert.strictEqual((await f.request(url.pathname + url.search)).status, 410);
  t.assert.deepStrictEqual(await f.users(), []);
  const audit = await f.db.get("SELECT user_id, detail_json FROM auth_events WHERE event = 'invitation_revoked'");
  t.assert.strictEqual(audit.user_id, f.admin.id);
  t.assert.deepStrictEqual(JSON.parse(audit.detail_json), { invitation_id: id });
  t.assert.strictEqual((await f.invite(email)).status, 201);
});

test('two simultaneous activation attempts issue only one session', async t => {
  const f = await fixture(t);
  const { token } = await issued(t, f);
  const results = await Promise.all([f.activate(token), f.activate(token)]);
  t.assert.deepStrictEqual(results.map(r => r.status).sort(), [200, 410]);
  t.assert.strictEqual((await f.db.all('SELECT id FROM sessions WHERE user_id = ?', (await f.users())[0].id)).length, 1);
});

test('existing accounts are reserved, including disabled accounts', async t => {
  const f = await fixture(t);
  const user = await f.createAccount(email);
  t.assert.strictEqual((await f.invite(email)).status, 409);
  await f.db.run('UPDATE users SET disabled_at = ? WHERE id = ?', new Date().toISOString(), user.id);
  t.assert.strictEqual((await f.invite(email)).status, 409);
  t.assert.deepStrictEqual(await f.db.all('SELECT id FROM invitations'), []);
  t.assert.strictEqual(f.mail.length, 0);
});

test('concurrent invitations for a normalized email yield one invite and a 409 suggesting revocation', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.invite(email), f.invite(' INVITEE@EXAMPLE.INVALID ')]);
  t.assert.deepStrictEqual(results.map(r => r.status).sort(), [201, 409]);
  t.assert.match(results.find(r => r.status === 409).body.error, /Revoke/);
  t.assert.strictEqual(f.mail.length, 1);
});

test('activation rejects a short password and the accepted password works at login', async t => {
  const f = await fixture(t);
  const { token } = await issued(t, f);
  t.assert.strictEqual((await f.activate(token, 'too-short')).status, 400);
  t.assert.deepStrictEqual(await f.users(), []);
  const chosen = 'A-different-synthetic-password!';
  t.assert.strictEqual((await f.activate(token, chosen)).status, 200);
  t.assert.strictEqual((await f.login(email, chosen)).status, 200);
  t.assert.strictEqual((await f.login(email, password)).status, 401);
});

test('a site owner and a bypass identity cannot administer invitations with no email disclosure', async t => {
  const f = await fixture(t, { authBypassUser: adminEmail });
  const { id } = await issued(t, f);
  const site = await createSite(f.db, { code: 'SYNTHETIC-INVITE', name: 'Synthetic site' });
  const ownerEmail = 'site-owner@example.invalid';
  const owner = await f.createAccount(ownerEmail);
  await f.db.run("INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, 'owner')", site.id, owner.id);
  const cookie = (await f.login(ownerEmail, password)).headers['set-cookie'].split(';')[0];
  const denied = await f.invite(adminEmail, { cookie });
  t.assert.strictEqual(denied.status, 403);
  t.assert.deepStrictEqual(denied, await f.invite('unknown@example.invalid', { cookie }));
  t.assert.strictEqual((await f.revoke(id, { cookie })).status, 403);
  t.assert.strictEqual((await f.invite(email, { cookie: undefined })).status, 401);
  t.assert.strictEqual((await f.revoke(id, { cookie: undefined })).status, 401);
  t.assert.strictEqual((await f.db.get('SELECT revoked_at FROM invitations WHERE id = ?', id)).revoked_at, null);
});

test('unconfigured mail returns 503 and creates no invitation', async t => {
  const f = await fixture(t, { mailer: createSmtpMailer({ env: {} }) });
  const result = await f.invite(email);
  t.assert.strictEqual(result.status, 503);
  t.assert.strictEqual(result.body.code, 'MAIL_NOT_CONFIGURED');
  t.assert.deepStrictEqual(await f.db.all('SELECT id FROM invitations'), []);
});

test('mail failure retains the committed invitation and concurrent retry sends one fresh link', async t => {
  const captured = [];
  const f = await fixture(t, { mailer: async message => {
    captured.push(message);
    const row = await f.db.get('SELECT delivery_status, delivery_attempts FROM invitations WHERE email = ?', email);
    t.assert.deepStrictEqual({ ...row }, { delivery_status: 'pending', delivery_attempts: 1 });
    throw new Error(message.text);
  } });
  const result = await f.invite(email);
  t.assert.strictEqual(result.status, 503);
  t.assert.strictEqual(result.body.code, 'MAIL_UNAVAILABLE');
  const { id } = result.body;
  const old = link(captured[0]).searchParams.get('token');
  t.assert.strictEqual(result.body.delivery_status, 'failed');
  t.assert.strictEqual(result.body.delivery_attempts, 1);
  t.assert.strictEqual(result.body.delivered_at, null);
  t.assert.ok(!JSON.stringify(result).includes(old));
  t.assert.strictEqual((await f.invite(email)).status, 409);
  let sends = 0;
  const mailer = async message => { sends++; captured.push(message); };
  const results = await Promise.allSettled([
    retryInvitation(f.db, id, { mailer, publicUrl }),
    retryInvitation(f.db, email, { mailer, publicUrl }),
  ]);
  t.assert.strictEqual(sends, 1);
  const sent = results.find(result => result.status === 'fulfilled').value;
  t.assert.strictEqual(results.find(result => result.status === 'rejected').reason.code, 'INVITATION_DELIVERY_CONFLICT');
  t.assert.strictEqual(sent.id, id);
  t.assert.strictEqual(sent.delivery_attempts, 2);
  t.assert.strictEqual(sent.delivery_status, 'sent');
  t.assert.strictEqual(sent.last_delivery_error, null);
  t.assert.strictEqual((await f.activate(old)).status, 410);
  const token = link(captured.at(-1)).searchParams.get('token');
  const events = await f.db.all("SELECT event, outcome, detail_json FROM auth_events WHERE event LIKE 'invitation_%'");
  t.assert.ok(events.some(event => event.event === 'invitation_delivery_failed' && event.outcome === 'failure'));
  t.assert.ok(events.some(event => event.event === 'invitation_retried'));
  const listed = await listInvitations(f.db);
  t.assert.deepStrictEqual(listed.map(row => row.id), [id]);
  t.assert.ok(!JSON.stringify([events, listed, sent]).includes(old) && !JSON.stringify([events, listed, sent]).includes(token));
  t.assert.strictEqual((await f.activate(token)).status, 200);
});

test('activation page works before the PWA fallback, verifies confirmation and redirects with a session', async t => {
  const f = await fixture(t, { staticDir: new URL('../app/', import.meta.url).pathname });
  const { token, url } = await issued(t, f);
  const page = await f.request(url.pathname + url.search);
  t.assert.strictEqual(page.status, 200);
  t.assert.strictEqual(page.headers['cache-control'], 'no-store');
  t.assert.strictEqual(page.headers['referrer-policy'], 'no-referrer');
  t.assert.ok(page.body.includes('name="confirmation"') && page.body.includes('minlength="12"'));
  t.assert.match(page.body, /<form[^>]+novalidate>/);
  t.assert.match(page.body, /<html lang="en">/);
  t.assert.match(page.body, /width=device-width/);
  t.assert.ok(!page.body.includes(token));
  t.assert.match(page.headers['content-security-policy'], /script-src 'sha256-/);
  t.assert.match(f.mail[0].html, /<html lang="en">/);
  t.assert.deepStrictEqual(await f.users(), []);
  const crossSite = await f.form(token, password, 'cross-site');
  t.assert.strictEqual(crossSite.status, 403);
  t.assert.ok(!crossSite.body.includes(token));
  t.assert.strictEqual((await f.form(token, 'Different password')).status, 400);
  const done = await submitActivationPage(t, f, page, url, 'Mobile browser');
  t.assert.strictEqual(done.status, 303);
  t.assert.strictEqual(done.headers.location, '/');
  t.assert.ok(done.headers['set-cookie']);
  const me = await f.request('/api/auth/me', { cookie: done.headers['set-cookie'].split(';')[0] });
  t.assert.strictEqual(me.body.user.language, 'en');
  const used = await f.request(url.pathname + url.search);
  t.assert.strictEqual(used.status, 410);
  t.assert.deepStrictEqual(used, await f.request('/attiva?token=invalid'));
  t.assert.ok(!used.body.includes(token));
});

test('invitation creation and activation limit attempts by both address and account', async t => {
  const f = await fixture(t);
  const { token } = await issued(t, f);
  for (let n = 1; n <= 10; n++) {
    t.assert.strictEqual((await f.activate(token, 'short', { ip: `192.0.2.${n}` })).status, 400);
    t.assert.strictEqual((await f.invite(`sample-${n}@example.invalid`, { ip: '192.0.2.50' })).status, 201);
  }
  const accountLimited = await f.activate(token, password, { ip: '192.0.2.30' });
  const ipLimited = await f.invite('other@example.invalid', { ip: '192.0.2.50' });
  for (const response of [accountLimited, ipLimited]) {
    t.assert.strictEqual(response.status, 429);
    t.assert.ok(Number(response.headers['retry-after']) > 0);
  }
  t.assert.deepStrictEqual(await f.users(), []);
});

test('permission commands are audited and idempotent and revocation applies to the current session', async t => {
  const f = await fixture(t);
  const existing = await f.createAccount(email);
  const cookie = (await f.login(email, password)).headers['set-cookie'].split(';')[0];
  t.assert.strictEqual((await f.invite(email, { cookie })).status, 403);
  t.assert.deepStrictEqual(await f.db.all('SELECT user_id FROM user_permissions WHERE user_id = ?', existing.id), []);
  await t.assert.rejects(f.permission('grant', 'unknown@example.invalid'), { code: 'USER_NOT_FOUND' });
  const rejected = await f.db.get("SELECT detail_json FROM auth_events WHERE event = 'permission_grant' AND outcome = 'failure'");
  t.assert.deepStrictEqual(JSON.parse(rejected.detail_json), {
    permission: INVITATION_PERMISSION, source: 'cli', code: 'USER_NOT_FOUND',
  });
  await t.assert.rejects(changePermission(f.db, 'grant', 'sites.manage', email), { code: 'INVALID_COMMAND' });
  t.assert.strictEqual((await f.permission('grant', ' INVITEE@EXAMPLE.INVALID ')).changed, true);
  t.assert.strictEqual((await f.permission('grant', email)).changed, false);
  t.assert.deepStrictEqual((await f.request('/api/sites', { cookie })).body, []);
  t.assert.strictEqual((await f.db.all('SELECT user_id FROM user_permissions WHERE user_id = ?', existing.id)).length, 1);
  const response = await f.invite('person@example.invalid', { cookie });
  t.assert.strictEqual(response.status, 201);
  t.assert.strictEqual((await f.permission('revoke', email)).active, false);
  t.assert.strictEqual((await f.permission('revoke', email)).changed, false);
  t.assert.strictEqual((await f.invite(adminEmail, { cookie })).status, 403);
  t.assert.strictEqual((await f.revoke(response.body.id, { cookie })).status, 403);
  const events = (await f.db.all("SELECT event, user_id, detail_json FROM auth_events WHERE event LIKE 'permission_%'"))
    .map(row => ({ ...row, detail: JSON.parse(row.detail_json) })).filter(row => row.detail.user_id === existing.id);
  t.assert.deepStrictEqual(events.map(row => [row.event, row.user_id, row.detail.changed]).sort(), [
    ['permission_grant', null, false], ['permission_grant', null, true],
    ['permission_revoke', null, false], ['permission_revoke', null, true],
  ]);
});

test('site assignments require owner authority and are rechecked when accepting', async t => {
  const f = await fixture(t);
  const site = await createSite(f.db, { code: 'INVITE-SITE', name: 'Synthetic invitation site' });
  const fields = { cantiere_id: site.id, role: 'verifier' };
  t.assert.strictEqual((await f.invite(email, undefined, { cantiere_id: site.id })).status, 400);
  t.assert.strictEqual((await f.invite(email, undefined, fields)).status, 403);
  await f.db.run("INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, 'editor')", site.id, f.admin.id);
  t.assert.strictEqual((await f.invite(email, undefined, fields)).status, 403);
  await f.db.run("UPDATE site_members SET role = 'owner' WHERE site_id = ? AND user_id = ?", site.id, f.admin.id);
  const { token } = await issued(t, f, fields);
  t.assert.strictEqual((await f.activate(token)).status, 200);
  t.assert.strictEqual((await f.db.get('SELECT role FROM site_members WHERE user_id = ?', (await f.users())[0].id)).role, 'verifier');

  const second = await f.invite('second@example.invalid', undefined, fields);
  t.assert.strictEqual(second.status, 201);
  await f.permission('revoke');
  const result = await f.activate(link(f.mail.at(-1)).searchParams.get('token'));
  t.assert.strictEqual(result.status, 200);
  t.assert.deepStrictEqual(await f.db.all('SELECT site_id FROM site_members WHERE user_id = ?', result.body.user.id), []);
});

test('Italian form validation and revoked links retain the invitation locale', async t => {
  const f = await fixture(t);
  const { token, url, id } = await issued(t, f, { locale: 'it' });
  const page = await f.request(url.pathname + url.search);
  t.assert.match(page.body, /<html lang="it">/);
  t.assert.match(page.body, /Conferma password/);
  const bad = await f.form(token, 'different', 'same-origin', 'Mobile browser');
  t.assert.match(bad.body, /usando da 12 a 1024 caratteri/);
  t.assert.match(bad.body, /<html lang="it">/);
  t.assert.ok(!bad.body.includes(token));
  t.assert.strictEqual((await f.revoke(id)).status, 200);
  const revoked = await f.request(url.pathname + url.search);
  t.assert.match(revoked.body, /<html lang="it">/);
  t.assert.match(revoked.body, /Chiedi un nuovo invito/);
  t.assert.strictEqual((await f.invite(email, undefined, { locale: 'xx' })).status, 400);
  const next = await issued(t, f, { locale: 'it' });
  const nextPage = await f.request(next.url.pathname + next.url.search);
  const done = await submitActivationPage(t, f, nextPage, next.url, 'Desktop browser');
  t.assert.strictEqual(done.status, 303);
  const me = await f.request('/api/auth/me', { cookie: done.headers['set-cookie'].split(';')[0] });
  t.assert.strictEqual(me.body.user.language, 'it');
});

test('create commit failure sends no mail and rolls back invitation and create audit', async t => {
  const f = await fixture(t);
  const transaction = f.db.transaction.bind(f.db);
  f.db.transaction = fn => transaction(async tx => {
    await fn(tx);
    throw new Error('Synthetic commit failure');
  });
  t.assert.strictEqual((await f.invite(email)).status, 500);
  t.assert.strictEqual(f.mail.length, 0);
  t.assert.deepStrictEqual(await f.db.all('SELECT id FROM invitations'), []);
  t.assert.deepStrictEqual(await f.db.all("SELECT id FROM auth_events WHERE event = 'invitation_created'"), []);
});

for (const interruption of ['before claim commit', 'after claim commit', 'after send']) {
  test(`interruption ${interruption} remains pending and reissue invalidates the old link`, async t => {
    const f = await fixture(t);
    const transaction = f.db.transaction.bind(f.db);
    let calls = 0;
    f.db.transaction = async fn => {
      const call = ++calls;
      const row = await transaction(async tx => {
        const result = await fn(tx);
        if ((interruption === 'before claim commit' && call === 2) || (interruption === 'after send' && call === 3)) {
          throw new Error('Synthetic interruption before commit');
        }
        return result;
      });
      if (interruption === 'after claim commit' && call === 2) throw new Error('Synthetic interruption after commit');
      return row;
    };
    t.assert.strictEqual((await f.invite(email, undefined, { locale: 'it' })).status, 500);
    f.db.transaction = transaction;
    const [pending] = await listInvitations(f.db);
    const after = interruption === 'after send';
    t.assert.strictEqual(pending.delivery_status, 'pending');
    t.assert.strictEqual(pending.delivery_attempts, Number(interruption !== 'before claim commit'));
    t.assert.strictEqual(f.mail.length, Number(after));
    const old = after ? link(f.mail[0]).searchParams.get('token') : null;
    const options = { mailer: async message => { f.mail.push(message); }, publicUrl };
    await t.assert.rejects(retryInvitation(f.db, pending.id, options), { code: 'INVITATION_DELIVERY_CONFLICT' });
    const replacement = await reissueInvitation(f.db, email, options);
    t.assert.notStrictEqual(replacement.id, pending.id);
    t.assert.strictEqual(replacement.locale, 'it');
    t.assert.strictEqual(replacement.delivery_status, 'sent');
    t.assert.ok((await f.db.get('SELECT revoked_at FROM invitations WHERE id = ?', pending.id)).revoked_at);
    if (old) t.assert.strictEqual((await f.activate(old)).status, 410);
    const token = link(f.mail.at(-1)).searchParams.get('token');
    t.assert.strictEqual((await revokeInvitation(f.db, email, null)).id, replacement.id);
    t.assert.strictEqual((await f.activate(token)).status, 410);
    t.assert.deepStrictEqual(await listInvitations(f.db), []);
    const events = await f.db.all('SELECT event, user_id, detail_json FROM auth_events');
    t.assert.ok(events.some(event => event.event === 'invitation_reissued' && event.user_id === null));
    t.assert.ok(events.some(event => event.event === 'invitation_revoked' && event.user_id === null));
    t.assert.ok(events.some(event => event.event === 'invitations_listed' && event.user_id === null));
  });
}
