import test from 'node:test';
import { isSecureRequest, sessionCookie } from '../server/auth.mjs';
import { createUser } from '../server/create-user.mjs';
import { createServer } from '../server/http.mjs';
import { openTestDb } from './helpers/db.mjs';
import { requestListener } from './helpers/auth.mjs';

const cases = [
  { name: 'plain HTTP', expected: false },
  { name: 'encrypted socket', encrypted: true, expected: true },
  { name: 'loopback proxy', ip: '127.0.0.1', proto: 'https', expected: true },
  { name: 'loopback IPv4 subnet', ip: '127.24.12.8', proto: 'https', expected: true },
  { name: 'loopback IPv6', ip: '::1', proto: 'https', expected: true },
  { name: 'mapped loopback IPv4', ip: '::ffff:127.0.0.1', proto: 'https', expected: true },
  { name: 'trimmed case-insensitive first value', ip: '127.0.0.1', proto: ' HTTPS , http', expected: true },
  { name: 'only first value counts', ip: '127.0.0.1', proto: 'http, https', expected: false },
  { name: 'untrusted proxy', ip: '192.0.2.10', proto: 'https', expected: false },
  { name: 'untrusted IPv6 proxy', ip: '2001:db8::1', proto: 'https', expected: false },
  { name: 'invalid loopback-like address', ip: '127.999.0.1', proto: 'https', expected: false },
  { name: 'missing peer', ip: '', proto: 'https', expected: false },
  { name: 'production fallback', production: true, expected: true },
];

for (const { name, ip = '127.0.0.1', proto, encrypted = false, production = false, expected } of cases) {
  test(`Secure cookies for ${name}: helper, login and logout`, async t => {
    const headers = proto === undefined ? {} : { 'x-forwarded-proto': proto };
    const secure = isSecureRequest({ socket: { remoteAddress: ip, encrypted }, headers }, { production });
    t.assert.strictEqual(secure, expected);
    const suffix = expected ? '; Secure' : '';
    t.assert.strictEqual(sessionCookie('synthetic-token', { production, secure }),
      `sa_session=synthetic-token; Path=/api; HttpOnly; SameSite=Lax; Max-Age=604800${suffix}`);
    const database = await openTestDb(); t.after(database.close);
    const body = { email: 'cookie@example.invalid', name: 'Synthetic cookie user', password: 'Synthetic-cookie-passphrase!' };
    await createUser(database.db, body);
    const request = requestListener(createServer(database.db, { production }));
    const login = await request('/api/auth/login', { method: 'POST', body, headers, ip, encrypted });
    t.assert.strictEqual(login.status, 200);
    const cookie = login.headers['set-cookie'];
    t.assert.strictEqual(cookie.endsWith('; Secure'), expected);
    const logout = await request('/api/auth/logout', { method: 'POST', body: {}, headers, ip, encrypted, cookie: cookie.split(';')[0] });
    t.assert.strictEqual(logout.status, 200);
    t.assert.strictEqual(logout.headers['set-cookie'], `sa_session=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0${suffix}`);
  });
}

test('sessionCookie stays compatible and explicit secure false cannot disable production fallback', t => {
  t.assert.strictEqual(isSecureRequest({}), false);
  t.assert.strictEqual(sessionCookie('token', { production: false }), 'sa_session=token; Path=/api; HttpOnly; SameSite=Lax; Max-Age=604800');
  t.assert.match(sessionCookie('token', { production: true, secure: false }), /; Secure$/);
});
