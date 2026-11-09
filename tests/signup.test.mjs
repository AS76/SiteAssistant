import test from 'node:test';
import { createServer } from '../server/http.mjs';
import { createUser } from '../server/create-user.mjs';
import { tokenHash, verifyPassword, login, createLoginLimiter } from '../server/auth.mjs';
import { DECISION_TTL } from '../server/signup.mjs';
import { createSmtpMailer, MailNotConfiguredError } from '../server/auth-mail.mjs';
import { openTestDb, isPg } from './helpers/db.mjs';
import { requestListener } from './helpers/auth.mjs';

const email = 'applicant@example.invalid';
const ownerEmail = 'owner@example.invalid';
const accepted = { status: 'accepted' };
const oldPassword = 'Synthetic-old-password!';
const newPassword = 'Synthetic-new-password!';
async function fixture(t, options = {}) {
  const database = await openTestDb(); t.after(database.close);
  const mail = [];
  const mailer = async message => { mail.push(message); };
  const request = requestListener(createServer(database.db, { mailer, ownerEmail, publicUrl: 'https://app.example.invalid', ...options }));
  const post = (path, body, cookie) => request(`/api/auth/${path}`, { method: 'POST', body, cookie });
  const decide = (url, decision = 'approve') => request('/api/auth/request/decide', {
    method: 'POST', rawBody: new URLSearchParams({ token: url.searchParams.get('token'), decision }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const user = () => createUser(database.db, { email, name: 'Synthetic applicant', password: oldPassword });
  const login = async (password = oldPassword) => {
    const result = await post('login', { email, password });
    t.assert.strictEqual(result.status, 200);
    return result.headers['set-cookie'].split(';')[0];
  };
  return { db: database.db, request, post, decide, mail, user, login };
}
const links = mail => [...mail.text.matchAll(/https:\/\/[^\s]+/g)].map(match => new URL(match[0]));
const path = url => url.pathname + url.search;
const temporary = mail => /Temporary password: ([^\s]+)/.exec(mail.text)[1];
async function signup(t, f) {
  const result = await f.post('request', { email: ' APPLICANT@EXAMPLE.INVALID ' });
  t.assert.strictEqual(result.status, 202);
  return links(f.mail.at(-1));
}

test('request stores only a decision hash, sends one review link, normalizes and deduplicates pending/users', async t => {
  const f = await fixture(t);
  const urls = await signup(t, f);
  t.assert.strictEqual(f.mail.length, 1);
  t.assert.strictEqual(f.mail[0].to, ownerEmail);
  t.assert.strictEqual(urls.length, 1);
  t.assert.strictEqual(urls[0].searchParams.has('decision'), false);
  t.assert.strictEqual(urls[0].pathname, '/api/auth/request/decide');
  const token = urls[0].searchParams.get('token');
  t.assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const rows = await f.db.all('SELECT * FROM signup_requests');
  t.assert.strictEqual(rows.length, 1);
  t.assert.strictEqual(rows[0].email, email);
  t.assert.strictEqual(rows[0].status, 'pending');
  t.assert.strictEqual(rows[0].decision_token_hash, tokenHash(token));
  t.assert.strictEqual(rows[0].completion_token_hash, null);
  t.assert.strictEqual(rows[0].decided_at, null);
  t.assert.ok(!JSON.stringify(rows).includes(token));
  t.assert.deepStrictEqual((await f.post('request', { email })).body, accepted);
  t.assert.strictEqual(f.mail.length, 1);
  await createUser(f.db, { email: 'existing@example.invalid', name: 'Existing synthetic user', password: oldPassword });
  const existing = await f.post('request', { email: 'EXISTING@EXAMPLE.INVALID' });
  const unknown = await f.post('request', { email: 'unknown@example.invalid' });
  t.assert.strictEqual(existing.status, unknown.status);
  t.assert.deepStrictEqual(existing.body, unknown.body);
  t.assert.strictEqual(f.mail.length, 2);
  t.assert.strictEqual((await f.db.all('SELECT * FROM signup_requests')).length, 2);
  for (const bad of ['', 'invalid', 'a@', 'a@b\r\n.example.invalid', null, 123]) {
    t.assert.strictEqual((await f.post('request', { email: bad })).status, 400);
  }
});

test('approval creates a login-capable temporary password, exposes me flag and consumes the token for GET and POST', async t => {
  const f = await fixture(t), urls = await signup(t, f);
  const approved = await f.decide(urls[0]);
  t.assert.strictEqual(approved.status, 200);
  assertDecisionHeaders(t, approved);
  t.assert.match(approved.headers['content-type'], /text\/html/);
  t.assert.strictEqual(approved.headers.location, undefined);
  t.assert.strictEqual(approved.headers['referrer-policy'], 'no-referrer');
  t.assert.match(approved.body, /SiteAssistant.*approved/s);
  t.assert.ok(!approved.body.includes(urls[0].searchParams.get('token')));
  const row = await f.db.get('SELECT * FROM users WHERE email = ?', email);
  t.assert.strictEqual(Boolean(row.password_change_required), true);
  const password = temporary(f.mail[1]);
  t.assert.match(password, /^[A-HJ-NP-Za-km-z2-9]{16}$/);
  t.assert.strictEqual(f.mail[1].to, email);
  t.assert.ok(await verifyPassword(password, row.password_hash));
  const cookie = await f.login(password);
  const me = await f.request('/api/auth/me', { cookie });
  t.assert.strictEqual(me.body.password_change_required, true);
  t.assert.deepStrictEqual(me.body.roles, []);
  t.assert.strictEqual((await f.request('/api/sites', { cookie })).status, 200);
  for (const url of urls) {
    const reused = await f.request(path(url));
    t.assert.strictEqual(reused.status, 410);
    t.assert.match(reused.body, /already been used/);
  }
  const repeated = await f.decide(urls[0]);
  t.assert.strictEqual(repeated.status, 410);
  assertDecisionHeaders(t, repeated);
  const rowAfter = await f.db.get('SELECT * FROM signup_requests');
  t.assert.strictEqual(rowAfter.status, 'approved');
  t.assert.ok(rowAfter.decided_at);
  t.assert.strictEqual(f.mail.length, 2);
});

test('reject consumes the link without creating a user or sending another email', async t => {
  const f = await fixture(t), urls = await signup(t, f);
  t.assert.strictEqual((await f.decide(urls[0], 'reject')).status, 200);
  t.assert.deepStrictEqual(await f.db.all('SELECT * FROM users'), []);
  t.assert.strictEqual((await f.db.get('SELECT status FROM signup_requests')).status, 'rejected');
  for (const url of urls) t.assert.strictEqual((await f.request(path(url))).status, 410);
  t.assert.strictEqual(f.mail.length, 1);
});

function assertDecisionHeaders(t, result) {
  t.assert.strictEqual(result.headers['referrer-policy'], 'no-referrer');
  t.assert.strictEqual(result.headers['cache-control'], 'no-store');
  t.assert.strictEqual(result.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
}

test('scanner prefetch: three GETs including decision=approve leave all rows and mail unchanged', async t => {
  const f = await fixture(t), [url] = await signup(t, f);
  const before = await f.db.all('SELECT * FROM signup_requests');
  const changes = !isPg ? await f.db.get('SELECT total_changes() AS count') : null;
  for (let i = 0; i < 3; i++) {
    if (i) url.searchParams.set('decision', 'approve');
    const result = await f.request(path(url));
    t.assert.strictEqual(result.status, 200);
    assertDecisionHeaders(t, result);
    t.assert.match(result.headers['content-type'], /text\/html/);
    t.assert.match(result.body, /<form method="post" action="\/api\/auth\/request\/decide">/);
    t.assert.ok(result.body.includes(`<input type="hidden" name="token" value="${url.searchParams.get('token')}">`));
    t.assert.match(result.body, /<button type="submit" name="decision" value="approve"[^>]*>Approva<\/button>/);
    t.assert.match(result.body, /<button type="submit" name="decision" value="reject"[^>]*>Rifiuta<\/button>/);
    t.assert.ok(result.body.includes(email));
    t.assert.ok(result.body.includes(new Date(before[0].requested_at).toISOString()));
    t.assert.match(result.body, /UTC/);
    t.assert.doesNotMatch(result.body, /<script|<link|<img/);
    t.assert.deepStrictEqual(await f.db.all('SELECT * FROM signup_requests'), before);
    t.assert.strictEqual((await f.db.get('SELECT status FROM signup_requests')).status, 'pending');
    t.assert.deepStrictEqual(await f.db.all('SELECT * FROM users'), []);
    t.assert.strictEqual(f.mail.length, 1);
    if (changes) t.assert.deepStrictEqual(await f.db.get('SELECT total_changes() AS count'), changes);
  }
});

test('missing, malformed, unknown, expired and used tokens return the identical HTML 410 on GET and POST', async t => {
  const f = await fixture(t), [url] = await signup(t, f);
  const token = url.searchParams.get('token');
  const gone = await f.request('/api/auth/request/decide');
  t.assert.strictEqual(gone.status, 410);
  async function assertGone(value) {
    for (const method of ['GET', 'POST']) {
      const params = new URLSearchParams(value === null ? {} : { token: value });
      const result = method === 'GET' ? await f.request(`/api/auth/request/decide?${params}`) :
        await f.request('/api/auth/request/decide', { method, rawBody: `${params}&decision=approve`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      t.assert.strictEqual(result.status, 410);
      t.assert.strictEqual(result.body, gone.body);
      t.assert.match(result.headers['content-type'], /text\/html/);
      assertDecisionHeaders(t, result);
    }
  }
  for (const value of [null, '', 'A'.repeat(43), '<script>']) await assertGone(value);
  await f.db.run('UPDATE signup_requests SET requested_at = ?', new Date(Date.now() - DECISION_TTL).toISOString());
  await assertGone(token);
  await f.db.run('UPDATE signup_requests SET requested_at = ?', new Date().toISOString());
  t.assert.strictEqual((await f.decide(url, 'reject')).status, 200);
  await assertGone(token);
  t.assert.deepStrictEqual(await f.db.all('SELECT * FROM users'), []);
  t.assert.strictEqual(f.mail.length, 1);
});

test('POST validates decisions, form Content-Type and the 4096-byte limit without side effects', async t => {
  const f = await fixture(t), [url] = await signup(t, f);
  const before = await f.db.all('SELECT * FROM signup_requests');
  const token = url.searchParams.get('token');
  for (const decision of ['delete', '', 'APPROVE']) {
    const result = await f.decide(url, decision);
    t.assert.strictEqual(result.status, 400);
    assertDecisionHeaders(t, result);
  }
  const body = new URLSearchParams({ token, decision: 'approve' }).toString();
  for (const contentType of [undefined, 'application/json', 'text/plain', 'multipart/form-data']) {
    const result = await f.request('/api/auth/request/decide', { method: 'POST', rawBody: body,
      headers: contentType ? { 'content-type': contentType } : {} });
    t.assert.strictEqual(result.status, 400);
    t.assert.strictEqual(result.body.code, 'INVALID_FORM');
    t.assert.match(result.headers['content-type'], /application\/json/);
    assertDecisionHeaders(t, result);
  }
  // Check bytes (not character count), including input split across chunks.
  for (const rawBody of [body.padEnd(4097, 'x'), body + '&pad=' + 'é'.repeat(2048), [Buffer.from(body), Buffer.alloc(4096, 120)]]) {
    const result = await f.request('/api/auth/request/decide', { method: 'POST', rawBody,
      headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    t.assert.strictEqual(result.status, 400);
    t.assert.strictEqual(result.body.code, 'INVALID_FORM');
    assertDecisionHeaders(t, result);
  }
  t.assert.deepStrictEqual(await f.db.all('SELECT * FROM signup_requests'), before);
  t.assert.deepStrictEqual(await f.db.all('SELECT * FROM users'), []);
  t.assert.strictEqual(f.mail.length, 1);
  const boundary = await f.request('/api/auth/request/decide', { method: 'POST',
    rawBody: (new URLSearchParams({ token, decision: 'reject' }).toString() + '&pad=').padEnd(4096, 'x'),
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' } });
  t.assert.strictEqual(boundary.status, 200);
  assertDecisionHeaders(t, boundary);
});

test('concurrent requests deduplicate and only one competing decision succeeds', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => f.post('request', { email })));
  for (const result of results) t.assert.strictEqual(result.status, 202);
  t.assert.strictEqual(f.mail.length, 1);
  const [url] = links(f.mail[0]);
  const decisions = await Promise.all([f.decide(url, 'approve'), f.decide(url, 'reject')]);
  t.assert.deepStrictEqual(decisions.map(result => result.status).sort(), [200, 410]);
  t.assert.strictEqual((await f.db.all('SELECT * FROM signup_requests')).length, 1);
});

test('password change validates credentials/policy, clears flag and preserves only the current session', async t => {
  const f = await fixture(t); await f.user();
  await f.db.run('UPDATE users SET password_change_required = true');
  const current = await f.login(), other = await f.login();
  t.assert.strictEqual((await f.post('password', { current_password: 'Wrong', new_password: newPassword }, current)).body.code, 'INVALID_CREDENTIALS');
  t.assert.strictEqual((await f.post('password', { current_password: 'Wrong', new_password: newPassword }, current)).status, 401);
  for (const password of ['short', oldPassword]) t.assert.strictEqual((await f.post('password', { current_password: oldPassword, new_password: password }, current)).status, 400);
  t.assert.strictEqual((await f.request('/api/auth/me', { cookie: other })).status, 200);
  t.assert.strictEqual((await f.post('password', { current_password: oldPassword, new_password: newPassword }, current)).status, 200);
  const me = await f.request('/api/auth/me', { cookie: current });
  t.assert.strictEqual(me.status, 200); t.assert.strictEqual(me.body.password_change_required, false);
  t.assert.strictEqual((await f.request('/api/auth/me', { cookie: other })).status, 401);
  t.assert.strictEqual((await f.post('login', { email, password: oldPassword })).status, 401);
  await f.login(newPassword);
  t.assert.strictEqual(f.mail.length, 0);
});

test('forgot rotates the password, revokes all sessions and hides unknown and disabled accounts', async t => {
  const f = await fixture(t); await f.user();
  const cookies = [await f.login(), await f.login()];
  const reset = await f.post('forgot', { email: email.toUpperCase() });
  t.assert.strictEqual(reset.status, 202); t.assert.deepStrictEqual(reset.body, accepted);
  t.assert.strictEqual(f.mail.length, 1); t.assert.strictEqual(f.mail[0].to, email);
  for (const cookie of cookies) t.assert.strictEqual((await f.request('/api/auth/me', { cookie })).status, 401);
  t.assert.strictEqual((await f.post('login', { email, password: oldPassword })).status, 401);
  const password = temporary(f.mail[0]);
  t.assert.match(password, /^[A-HJ-NP-Za-km-z2-9]{16}$/);
  const cookie = await f.login(password);
  t.assert.strictEqual((await f.request('/api/auth/me', { cookie })).body.password_change_required, true);
  await f.db.run('UPDATE users SET disabled_at = ?', new Date().toISOString());
  const before = await f.db.get('SELECT * FROM users'), sessions = await f.db.all('SELECT * FROM sessions ORDER BY id');
  for (const address of [email, 'absent@example.invalid']) {
    const result = await f.post('forgot', { email: address });
    t.assert.strictEqual(result.status, reset.status); t.assert.deepStrictEqual(result.body, reset.body);
  }
  t.assert.strictEqual(f.mail.length, 1);
  t.assert.deepStrictEqual(await f.db.get('SELECT * FROM users'), before);
  t.assert.deepStrictEqual(await f.db.all('SELECT * FROM sessions ORDER BY id'), sessions);
});

test('request and forgot use independent ten-attempt limits per IP/email; password uses user ID', async t => {
  const f = await fixture(t); await f.user(); const cookie = await f.login();
  for (const endpoint of ['request', 'forgot']) {
    for (let i = 0; i < 10; i++) t.assert.strictEqual((await f.post(endpoint, { email: 'absent@example.invalid' })).status, 202);
    const result = await f.post(endpoint, { email: ' ABSENT@EXAMPLE.INVALID ' });
    t.assert.strictEqual(result.status, 429); t.assert.strictEqual(result.body.code, 'RATE_LIMITED');
    t.assert.ok(Number(result.headers['retry-after']) > 0);
  }
  for (let i = 0; i < 10; i++) t.assert.strictEqual((await f.post('password', { current_password: 'Wrong', new_password: newPassword }, cookie)).status, 401);
  const second = await f.login();
  t.assert.strictEqual((await f.post('password', { current_password: oldPassword, new_password: newPassword }, second)).status, 429);
  t.assert.strictEqual((await f.request('/api/auth/password', { method: 'POST', cookie, ip: '127.0.0.2', body: { current_password: oldPassword, new_password: newPassword } })).status, 200);
});

test('missing OWNER_EMAIL returns 503 without creating rows or sending mail', async t => {
  const previous = process.env.OWNER_EMAIL;
  delete process.env.OWNER_EMAIL;
  t.after(() => {
    if (previous === undefined) delete process.env.OWNER_EMAIL;
    else process.env.OWNER_EMAIL = previous;
  });
  for (const value of [undefined, '', '   ']) {
    const f = await fixture(t, { ownerEmail: value });
    const result = await f.post('request', { email });
    t.assert.strictEqual(result.status, 503);
    t.assert.strictEqual(result.body.code, 'MAIL_NOT_CONFIGURED');
    t.assert.deepStrictEqual(await f.db.all('SELECT * FROM signup_requests'), []);
    t.assert.deepStrictEqual(await f.db.all('SELECT * FROM users'), []);
    t.assert.deepStrictEqual(await f.db.all('SELECT * FROM sessions'), []);
    t.assert.strictEqual(f.mail.length, 0);
  }
});

test('missing SMTP configuration returns uniform 503 and persists nothing', async t => {
  const f = await fixture(t, { mailer: createSmtpMailer({ env: {} }) });
  await f.user(); const cookie = await f.login();
  const before = await f.db.get('SELECT * FROM users');
  for (const endpoint of ['request', 'forgot']) {
    for (const address of [email, 'absent@example.invalid']) {
      const result = await f.post(endpoint, { email: address });
      t.assert.strictEqual(result.status, 503); t.assert.strictEqual(result.body.code, 'MAIL_NOT_CONFIGURED');
    }
  }
  t.assert.deepStrictEqual(await f.db.all('SELECT * FROM signup_requests'), []);
  t.assert.deepStrictEqual(await f.db.get('SELECT * FROM users'), before);
  t.assert.strictEqual((await f.request('/api/auth/me', { cookie })).status, 200);
});

test('mail failure rolls back request, approval and password reset, permitting a retry', async t => {
  let fail = false;
  const mail = [];
  const f = await fixture(t, { mailer: async message => { if (fail) throw new MailNotConfiguredError(); mail.push(message); } });
  fail = true;
  t.assert.strictEqual((await f.post('request', { email })).status, 503);
  t.assert.deepStrictEqual(await f.db.all('SELECT * FROM signup_requests'), []);
  fail = false; await f.post('request', { email }); const [url] = links(mail[0]);
  fail = true;
  t.assert.strictEqual((await f.decide(url)).status, 503);
  t.assert.strictEqual((await f.db.get('SELECT status FROM signup_requests')).status, 'pending');
  t.assert.deepStrictEqual(await f.db.all('SELECT * FROM users'), []);
  fail = false; t.assert.strictEqual((await f.decide(url)).status, 200);
  const cookie = await f.login(temporary(mail[1]));
  const before = await f.db.get('SELECT * FROM users');
  fail = true; t.assert.strictEqual((await f.post('forgot', { email })).status, 503);
  t.assert.deepStrictEqual(await f.db.get('SELECT * FROM users'), before);
  t.assert.strictEqual((await f.request('/api/auth/me', { cookie })).status, 200);
});


test('a login already verifying an old password cannot create a session after reset', async t => {
  const f = await fixture(t); await f.user();
  let release, captured;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { captured = resolve; });
  const pending = login({
    get: async (...args) => { const row = await f.db.get(...args); captured(); await gate; return row; },
    transaction: fn => f.db.transaction(fn),
  }, { email, password: oldPassword }, { limiter: createLoginLimiter() });
  // Attach the rejection assertion before releasing the paused login.
  const rejected = t.assert.rejects(pending, error => error.code === 'INVALID_CREDENTIALS');
  await ready;
  t.assert.strictEqual((await f.post('forgot', { email })).status, 202);
  release(); await rejected;
  t.assert.deepStrictEqual(await f.db.all('SELECT * FROM sessions'), []);
});
