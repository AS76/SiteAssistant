import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { hashPassword, login, createLoginLimiter } from '../../server/auth.mjs';

export async function authFixture(db, site) {
  const users = {}, cookies = {};
  for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
    const user = { id: randomUUID(), email: `${role}@example.invalid`, name: `Example ${role}` };
    await db.run(`INSERT INTO users (id, email, name, password_hash, password_algo, created_at)
      VALUES (?, ?, ?, ?, 'scrypt', ?)`, user.id, user.email, user.name,
    await hashPassword('Synthetic-test-password!'), new Date().toISOString());
    if (site) await db.run('INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, ?)', site.id, user.id, role);
    const result = await login(db, { email: user.email, password: 'Synthetic-test-password!' }, { limiter: createLoginLimiter() });
    users[role] = user;
    cookies[role] = `sa_session=${result.token}`;
  }
  return { users, cookies };
}

// Invoke the real listener without sockets; this is not a replacement for listen tests.
export function requestListener(server) {
  return (path, { method = 'GET', body, rawBody, headers = {}, cookie, ip = '127.0.0.1', encrypted = false } = {}) => {
    const request = Readable.from(rawBody !== undefined ? (Array.isArray(rawBody) ? rawBody : [Buffer.from(rawBody)]) : body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    request.url = path; request.method = method;
    request.headers = { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers, ...(cookie ? { cookie } : {}) };
    request.socket = { remoteAddress: ip, encrypted };
    return new Promise(resolve => {
      const values = {};
      const response = {
        setHeader: (name, value) => { values[name.toLowerCase()] = value; },
        writeHead(status, extra = {}) { response.status = status; for (const [key, value] of Object.entries(extra)) response.setHeader(key, value); },
        end(raw) { resolve({ status: response.status, headers: values, body: raw ? (values['content-type']?.startsWith('text/html') ? raw : JSON.parse(raw)) : null }); },
      };
      server.emit('request', request, response);
    });
  };
}
