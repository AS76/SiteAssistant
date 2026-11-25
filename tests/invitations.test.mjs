import test from 'node:test';
import { createServer } from '../server/http.mjs';
import { tokenHash } from '../server/auth.mjs';
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
  await db.run('UPDATE users SET is_admin = TRUE WHERE id = ?', admin.id);
  const cookie = (await login(adminEmail, password)).headers['set-cookie'].split(';')[0];
  const invite = (email, options) => post(invitations, { email }, { cookie, ...options });
  const revoke = (id, options) => post(`${invitations}/${id}/revoke`, undefined, { cookie, ...options });
  const activate = (token, chosen = password, options) => post('/api/auth/activate', { token, password: chosen }, options);
  const form = (token, confirmation, site = 'same-origin') => request('/api/auth/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': site },
    rawBody: new URLSearchParams({ token, password, confirmation }).toString(),
  });
  const users = () => db.all('SELECT id FROM users WHERE lower(email) = ?', email);
  return { db, mail, admin, request, invite, revoke, activate, form, login, users, createAccount };
}

async function issued(t, f) {
  const response = await f.invite(' INVITEE@EXAMPLE.INVALID ');
  t.assert.strictEqual(response.status, 201);
  const message = f.mail.at(-1);
  const url = new URL(message.text.match(/^https:\/\/\S+$/m)[0]);
  return { id: response.body.id, response, message, token: url.searchParams.get('token'), url };
}

async function verifyRoundTrip(t, f) {
  const { id, response, message, token, url } = await issued(t, f);
  t.assert.strictEqual(f.mail.length, 1);
  t.assert.strictEqual(message.subject, 'Il tuo invito a SiteAssistant');
  t.assert.strictEqual(message.to, email);
  t.assert.match(message.text, /72 ore/);
  t.assert.match(message.text, /nessuno te la chiederà via email/);
  t.assert.ok(!message.text.includes(password) && !message.html.includes(password));
  t.assert.strictEqual(url.origin, publicUrl);
  t.assert.strictEqual(url.pathname, '/attiva');
  t.assert.ok(/^[A-Za-z0-9_-]{43}$/.test(token));
  const row = await f.db.get('SELECT * FROM invitations WHERE id = ?', id);
  t.assert.strictEqual(row.email, email);
  t.assert.strictEqual(row.created_by, f.admin.id);
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
  t.assert.strictEqual(me.body.password_change_required, false);
  t.assert.deepStrictEqual(me.body.roles, []);
  t.assert.strictEqual((await f.activate(token)).status, 410);
  t.assert.strictEqual((await f.users()).length, 1);
  const events = await f.db.all("SELECT user_id, event, detail_json FROM auth_events WHERE event LIKE 'invitation_%' ORDER BY event");
  t.assert.deepStrictEqual(events.map(e => [e.event, e.user_id, JSON.parse(e.detail_json)]), [
    ['invitation_created', f.admin.id, { invitation_id: id }],
    ['invitation_used', result.body.user.id, { invitation_id: id }],
  ]);
  t.assert.ok(!JSON.stringify(events).includes(token));
}

test('invitation emails contain a 72-hour link and activation creates exactly one account and session', async t => {
  await verifyRoundTrip(t, await fixture(t));
});

test('PostgreSQL migration and invitation round trip work in PGlite', async t => {
  await verifyRoundTrip(t, await fixture(t, {}, await database(t, 'pg')));
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
  t.assert.match(page.body, /Chiedi un nuovo invito all’amministratore/);
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

test('delivery failure rolls back the invitation and audit event, permitting retry', async t => {
  let attempts = 0;
  const f = await fixture(t, { mailer: async () => {
    if (++attempts === 1) throw new Error('Synthetic delivery failure');
  } });
  const result = await f.invite(email);
  t.assert.strictEqual(result.status, 503);
  t.assert.strictEqual(result.body.code, 'MAIL_UNAVAILABLE');
  t.assert.deepStrictEqual(await f.db.all('SELECT id FROM invitations'), []);
  t.assert.deepStrictEqual(await f.db.all('SELECT id FROM auth_events'), []);
  t.assert.strictEqual((await f.invite(email)).status, 201);
});

test('activation page works before the PWA fallback, verifies confirmation and redirects with a session', async t => {
  const f = await fixture(t, { staticDir: new URL('../app/', import.meta.url).pathname });
  const { token, url } = await issued(t, f);
  const page = await f.request(url.pathname + url.search);
  t.assert.strictEqual(page.status, 200);
  t.assert.strictEqual(page.headers['cache-control'], 'no-store');
  t.assert.strictEqual(page.headers['referrer-policy'], 'no-referrer');
  t.assert.ok(page.body.includes('name="confirmation"') && page.body.includes('minlength="12"'));
  t.assert.deepStrictEqual(await f.users(), []);
  const crossSite = await f.form(token, password, 'cross-site');
  t.assert.strictEqual(crossSite.status, 403);
  t.assert.ok(!crossSite.body.includes(token));
  t.assert.strictEqual((await f.form(token, 'Different password')).status, 400);
  const done = await f.form(token, password);
  t.assert.strictEqual(done.status, 303);
  t.assert.strictEqual(done.headers.location, '/');
  t.assert.ok(done.headers['set-cookie']);
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
