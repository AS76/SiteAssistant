import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { createApi } from '../app/api.mjs';
import { messages } from '../app/i18n.mjs';
import { createLoginLimiter, hashPassword } from '../server/auth.mjs';
import { createServer } from '../server/http.mjs';
import { requestListener } from './helpers/auth.mjs';
import { openTestDb } from './helpers/db.mjs';

const email = 'login@example.invalid';
const password = 'Synthetic-test-password!';
const incorrect = 'Synthetic-incorrect-password!';
const invalid = { error: 'Invalid email or password.', code: 'INVALID_CREDENTIALS' };

async function fixture(t) {
  const { db, close } = await openTestDb();
  t.after(close);
  await db.run(`INSERT INTO users (id, email, name, password_hash, password_algo, created_at)
    VALUES (?, ?, ?, ?, 'scrypt', ?)`, randomUUID(), email, 'Synthetic user',
  await hashPassword(password), new Date().toISOString());
  let now = 0;
  const limiter = createLoginLimiter({ now: () => now });
  const request = requestListener(createServer(db, { limiter, webauthn: {
    rpID: 'example.invalid', origin: 'https://example.invalid',
    authenticationOptions: async options => ({ ...options, challenge: randomUUID() }),
  } }));
  const login = (givenPassword, address = email, ip) => request('/api/auth/login', {
    method: 'POST', ip, body: { email: address, password: givenPassword },
  });
  return { db, login, request, advance: ms => { now += ms; } };
}

test('ten failures return generic 401, followed by 429 before the account lookup', async t => {
  const { db, login, advance } = await fixture(t);
  const lookup = t.mock.method(db, 'get');
  for (let index = 0; index < 10; index++) {
    const wrong = await login(incorrect);
    t.assert.equal(wrong.status, 401);
    t.assert.deepEqual(wrong.body, invalid);
    t.assert.equal(wrong.headers['retry-after'], undefined);
  }
  t.assert.equal(lookup.mock.callCount(), 10);
  const blocked = await login(incorrect);
  t.assert.equal(blocked.status, 429);
  t.assert.deepEqual(blocked.body, {
    error: 'Troppi tentativi di accesso. Riprova tra 15 minuti.', code: 'RATE_LIMITED', retry_after: 900,
  });
  t.assert.equal(blocked.headers['retry-after'], '900');
  const correctWhileBlocked = await login(password, ' LOGIN@EXAMPLE.INVALID ');
  t.assert.equal(correctWhileBlocked.status, 429);
  t.assert.deepEqual(correctWhileBlocked.body, blocked.body);
  t.assert.equal(correctWhileBlocked.headers['set-cookie'], undefined);
  t.assert.equal(lookup.mock.callCount(), 10);

  advance(899_999);
  const lastSecond = await login(password);
  t.assert.equal(lastSecond.status, 429);
  t.assert.equal(lastSecond.headers['retry-after'], '1');
  t.assert.equal(lastSecond.body.retry_after, 1);
  t.assert.equal(lastSecond.body.error, 'Troppi tentativi di accesso. Riprova tra 1 minuti.');
  advance(1);
  t.assert.equal((await login(password)).status, 200);
});

test('twelve consecutive successful logins leave the failure budget intact', async t => {
  const { login } = await fixture(t);
  for (let index = 0; index < 12; index++) t.assert.equal((await login(password)).status, 200);
  t.assert.equal((await login(incorrect)).status, 401);
});

test('a successful login clears failures for the normalized account across IPs', async t => {
  const { login } = await fixture(t);
  const otherIp = '192.0.2.1';
  for (let index = 0; index < 4; index++) {
    t.assert.equal((await login(incorrect)).status, 401);
    t.assert.equal((await login(incorrect, email, otherIp)).status, 401);
  }
  t.assert.equal((await login(password, ' LOGIN@EXAMPLE.INVALID ')).status, 200);
  for (let index = 0; index < 5; index++) {
    t.assert.equal((await login(incorrect)).status, 401);
    t.assert.equal((await login(incorrect, email, otherIp)).status, 401);
  }
  t.assert.equal((await login(incorrect, email, otherIp)).status, 429);
  t.assert.equal((await login(password)).status, 429);
});

test('unknown and disabled accounts return the same 401 as an incorrect password', async t => {
  const { db, login } = await fixture(t);
  const comparison = await login(incorrect);
  await db.run('UPDATE users SET disabled_at = ? WHERE email = ?', new Date().toISOString(), email);
  for (const response of [await login(password), await login(password, 'missing@example.invalid')]) {
    t.assert.equal(response.status, 401);
    t.assert.deepEqual(response.body, comparison.body);
    t.assert.equal(response.headers['set-cookie'], undefined);
  }
});

test('simultaneous requests for one account across IPs cannot admit an eleventh password check', async t => {
  const { db, login } = await fixture(t);
  const lookup = t.mock.method(db, 'get');
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => login(incorrect, email, `192.0.2.${index + 1}`)));
  t.assert.deepEqual(results.map(result => result.status).sort(), [...Array(10).fill(401), 429, 429]);
  t.assert.equal(lookup.mock.callCount(), 10);
});

test('passkey options keep their own request limit without consuming password failures', async t => {
  const { login, request } = await fixture(t);
  const options = () => request('/api/auth/webauthn/login/options', { method: 'POST', body: { email } });
  for (let index = 0; index < 10; index++) t.assert.equal((await options()).status, 200);
  t.assert.equal((await options()).status, 429);
  t.assert.equal((await login(password)).status, 200);
  t.assert.equal((await options()).status, 429);
});

test('the login API client prefers Retry-After and accepts retry_after as a fallback', async t => {
  for (const [headers, seconds] of [[{ 'Retry-After': '61' }, 61], [{}, 900]]) {
    const api = createApi({ fetchImpl: async () => Response.json({
      error: 'Troppi tentativi di accesso. Riprova tra 15 minuti.', code: 'RATE_LIMITED', retry_after: 900,
    }, { status: 429, headers }) });
    await t.assert.rejects(() => api.login({ email, password }), { status: 429, code: 'RATE_LIMITED', retryAfter: seconds });
  }
});

test('the login form localizes the 429 and keeps the submit button locked until expiry', async t => {
  const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
  const main = { setAttribute() {}, set innerHTML(html) { t.assert.match(html, /id="login-rate-limit"/); form = makeForm(); } };
  const makeForm = () => {
    const submit = { disabled: false }, notice = { hidden: true, focus() { this.focused = true; } }, error = { hidden: true };
    return { id: 'login-form', dataset: {}, isConnected: true, submit, notice,
      querySelector: selector => ({ '[type=submit]': submit, '#login-rate-limit': notice, '.form-error': error })[selector],
    };
  };
  let form, submitForm, tick, now = 0, language = 'it', calls = 0;
  const context = createContext({
    view: 'overview', session: null, loading: false, loadError: null, siteId: null, modalVersion: 0,
    document: { body: { classList: { toggle() {} } }, addEventListener(_type, handler) { submitForm = handler; } },
    $: selector => selector === '#main' ? main : form,
    Date: { now: () => now }, setTimeout: next => { tick = next; }, clearTimeout: () => { tick = undefined; },
    t: key => messages[language][key], button: () => '', supportsPasskeys: () => false, renderChrome() {},
    dateFormData: () => ({ email, password }), accountLock: run => run(), flushLogout: async () => {},
    api: createApi({ fetchImpl: async () => {
      calls++;
      return Response.json({ code: 'RATE_LIMITED' }, { status: 429, headers: { 'Retry-After': '61' } });
    } }),
  });
  for (const [start, end] of [['let loginRetryUntil', 'async function passkeyLogin'],
    ['function render() {', 'function go('], ["document.addEventListener('submit',", "$('#modal').addEventListener('cancel'"]]) {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    t.assert.ok(from >= 0 && to > from);
    runInContext(source.slice(from, to), context);
  }
  runInContext('render()', context);
  await submitForm({ target: form, preventDefault() {} });
  t.assert.equal(form.notice.textContent, 'Troppi tentativi di accesso. Riprova tra 2 minuti.');
  t.assert.equal(form.notice.focused, true);
  t.assert.equal(form.submit.textContent, 'Accedi (1:01)');
  t.assert.equal(form.submit.disabled, true);
  await submitForm({ target: form, preventDefault() {} });
  t.assert.equal(calls, 1);

  language = 'en'; now = 1000;
  runInContext('render()', context);
  t.assert.equal(form.notice.textContent, 'Too many sign-in attempts. Try again in 1 minute.');
  t.assert.equal(form.submit.textContent, 'Sign in (1:00)');
  t.assert.equal(form.submit.disabled, true);
  now = 60_000; tick();
  t.assert.equal(form.submit.textContent, 'Sign in (0:01)');
  t.assert.equal(form.submit.disabled, true);
  now = 61_000; tick();
  t.assert.equal(form.notice.hidden, true);
  t.assert.equal(form.submit.textContent, 'Sign in');
  t.assert.equal(form.submit.disabled, false);
});
