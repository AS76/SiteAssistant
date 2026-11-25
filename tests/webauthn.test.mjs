import test from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { createWebAuthn } from '../server/webauthn.mjs';
import { tokenHash } from '../server/auth.mjs';
import { openTestDb } from './helpers/db.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { createServer } from '../server/http.mjs';

async function fixture(t) {
  const database = await openTestDb(); t.after(database.close);
  const db = database.db;
  const { users, cookies } = await authFixture(db);
  let at = Date.now(), valid = true;
  const credentialId = Buffer.from(randomUUID()).toString('base64url');
  const options = {
    registrationOptions: async opts => ({ challenge: randomBytes(32).toString('base64url'), user: { id: Buffer.from(opts.userID).toString('base64url') },
      authenticatorSelection: opts.authenticatorSelection, attestation: opts.attestationType, excludeCredentials: opts.excludeCredentials }),
    authenticationOptions: async opts => ({ challenge: randomBytes(32).toString('base64url'), ...opts }),
    rpID: 'example.invalid', origin: 'https://example.invalid', now: () => at,
    verifyRegistration: async args => {
      t.assert.equal(args.expectedRPID, 'example.invalid');
      t.assert.equal(args.expectedOrigin, 'https://example.invalid');
      t.assert.equal(args.requireUserVerification, true);
      t.assert.equal(await args.expectedChallenge(current.challenge), true);
      return { verified: valid, registrationInfo: { credential: { id: credentialId, publicKey: new Uint8Array([1, 2]), counter: 0, transports: ['internal'] },
        userVerified: true, credentialDeviceType: 'multiDevice', credentialBackedUp: true, fmt: 'none' } };
    },
    verifyAuthentication: async args => {
      t.assert.equal(args.requireUserVerification, true);
      t.assert.deepEqual([...args.credential.publicKey], [1, 2]);
      t.assert.deepEqual(args.credential.transports, ['internal']);
      t.assert.equal(await args.expectedChallenge(current.challenge), true);
      return { verified: valid, authenticationInfo: { newCounter: 1, userVerified: true, credentialBackedUp: true } };
    },
  };
  const api = createWebAuthn(db, options);
  let current;
  const registration = async () => {
    current = await api.registrationOptions(users.owner);
    return api.registrationVerify(users.owner, { challenge_id: current.challenge_id, response: { id: credentialId } });
  };
  return { db, users, cookies, api, options, credentialId, registration,
    setCurrent: value => { current = value; }, setValid: value => { valid = value; }, advance: ms => { at += ms; } };
}

test('registration stores hashed challenges, stable user handle, excludes credentials and audits success', async t => {
  const f = await fixture(t);
  const a = await f.api.registrationOptions(f.users.owner);
  const b = await f.api.registrationOptions(f.users.owner);
  t.assert.equal(a.user.id, b.user.id);
  t.assert.equal(a.authenticatorSelection.residentKey, 'preferred');
  t.assert.equal(a.authenticatorSelection.userVerification, 'required');
  t.assert.equal(a.attestation, 'none');
  const row = await f.db.get('SELECT * FROM webauthn_challenges WHERE id = ?', a.challenge_id);
  t.assert.equal(row.challenge_hash, tokenHash(a.challenge));
  t.assert.equal(Object.values(row).includes(a.challenge), false);
  t.assert.equal(Date.parse(row.expires_at) - Date.parse(row.created_at), 300000);
  await f.registration();
  const c = await f.api.registrationOptions(f.users.owner);
  t.assert.equal(c.excludeCredentials[0].id, f.credentialId);
  t.assert.equal((await f.db.get('SELECT * FROM auth_events')).outcome, 'success');
});

test('expired and replayed challenges fail and audit failures', async t => {
  const f = await fixture(t);
  const a = await f.api.registrationOptions(f.users.owner);
  f.advance(300000);
  await t.assert.rejects(() => f.api.registrationVerify(f.users.owner, { challenge_id: a.challenge_id, response: { id: f.credentialId } }), { code: 'INVALID_CREDENTIALS' });
  await f.registration();
  const used = await f.db.get("SELECT * FROM webauthn_challenges WHERE used_at IS NOT NULL");
  await t.assert.rejects(() => f.api.registrationVerify(f.users.owner, { challenge_id: used.id, response: { id: f.credentialId } }), { code: 'INVALID_CREDENTIALS' });
  t.assert.equal((await f.db.all("SELECT * FROM auth_events WHERE outcome = 'failure'")).length, 2);
});

test('login known, unknown and discoverable options; verified sessions have passkey assurance', async t => {
  const f = await fixture(t); await f.registration();
  await f.db.run("UPDATE users SET language = 'it', shared_demo = true WHERE id = ?", f.users.owner.id);
  const known = await f.api.loginOptions({ email: f.users.owner.email });
  const unknown = await f.api.loginOptions({ email: 'unknown@example.invalid' });
  const discoverable = await f.api.loginOptions({ discoverable: true });
  t.assert.equal(known.allowCredentials[0].id, f.credentialId);
  t.assert.equal(unknown.allowCredentials.length, 1);
  t.assert.deepEqual(discoverable.allowCredentials, []);
  f.setCurrent(known);
  const input = { challenge_id: known.challenge_id, response: { id: f.credentialId } };
  const result = await f.api.loginVerify(input);
  t.assert.equal(result.assurance, 'passkey');
  t.assert.deepEqual(result.user, { ...f.users.owner, language: 'it', shared_demo: true });
  const session = await f.db.get('SELECT * FROM sessions WHERE token_hash = ?', tokenHash(result.token));
  t.assert.equal(session.assurance, 'passkey'); t.assert.equal(session.auth_method, 'webauthn');
  t.assert.equal((await f.db.get('SELECT * FROM webauthn_credentials')).sign_count, 1);
  await t.assert.rejects(() => f.api.loginVerify(input), { code: 'INVALID_CREDENTIALS' });
});

test('failed verification consumes challenge, audits failure and creates no session', async t => {
  const f = await fixture(t); await f.registration(); f.setValid(false);
  const a = await f.api.loginOptions({ email: f.users.owner.email }); f.setCurrent(a);
  const before = (await f.db.all('SELECT * FROM sessions')).length;
  await t.assert.rejects(() => f.api.loginVerify({ challenge_id: a.challenge_id, response: { id: f.credentialId } }), { code: 'INVALID_CREDENTIALS' });
  t.assert.equal((await f.db.all('SELECT * FROM sessions')).length, before);
  t.assert.ok((await f.db.get('SELECT * FROM webauthn_challenges WHERE id = ?', a.challenge_id)).used_at);
  t.assert.equal((await f.db.get("SELECT * FROM auth_events WHERE event = 'webauthn.authentication'")).outcome, 'failure');
});

test('credentials are scoped, rename validated, last credential deletion refused', async t => {
  const f = await fixture(t); const credential = await f.registration();
  await t.assert.rejects(() => f.api.manageCredential(f.users.owner, credential.id, null), { code: 'LAST_CREDENTIAL' });
  await t.assert.rejects(() => f.api.manageCredential(f.users.editor, credential.id, { name: 'New name' }), { code: 'NOT_FOUND' });
  await t.assert.rejects(() => f.api.manageCredential(f.users.owner, credential.id, { name: '' }), { code: 'VALIDATION_ERROR' });
  await f.api.manageCredential(f.users.owner, credential.id, { name: 'Test key' });
  t.assert.equal((await f.api.credentials(f.users.owner))[0].name, 'Test key');
  t.assert.equal((await f.api.credentials(f.users.owner))[0].public_key, undefined);
});

test('routes require real sessions, validate input and set login cookie only on success', async t => {
  const f = await fixture(t);
  const request = requestListener(createServer(f.db, { webauthn: f.options, authBypassUser: f.users.owner.email }));
  for (const [path, method] of [['/api/auth/webauthn/register/options', 'POST'], ['/api/auth/webauthn/register/verify', 'POST'], ['/api/auth/credentials', 'GET'], [`/api/auth/credentials/${randomUUID()}`, 'PATCH'], [`/api/auth/credentials/${randomUUID()}`, 'DELETE']]) {
    t.assert.equal((await request(path, { method, body: {} })).status, 401);
  }
  t.assert.equal((await request('/api/auth/webauthn/login/options', { method: 'POST', body: { email: 2 } })).status, 400);
  t.assert.equal((await request('/api/auth/webauthn/register/verify', { method: 'POST', cookie: f.cookies.owner, body: {} })).status, 400);
  await f.registration();
  const a = await request('/api/auth/webauthn/login/options', { method: 'POST', body: { email: f.users.owner.email } }); f.setCurrent(a.body);
  const success = await request('/api/auth/webauthn/login/verify', { method: 'POST', body: { challenge_id: a.body.challenge_id, response: { id: f.credentialId } } });
  t.assert.equal(success.status, 200); t.assert.match(success.headers['set-cookie'], /HttpOnly/);
  const failure = await request('/api/auth/webauthn/login/verify', { method: 'POST', body: {} });
  t.assert.equal(failure.status, 400); t.assert.equal(failure.headers['set-cookie'], undefined);
});

test('discoverable login binds userHandle; unknown-email and wrong-user attempts fail', async t => {
  const f = await fixture(t); await f.registration();
  const discoverable = await f.api.loginOptions({ discoverable: true }); f.setCurrent(discoverable);
  const response = { id: f.credentialId, response: { userHandle: Buffer.from(f.users.owner.id).toString('base64url') } };
  t.assert.equal((await f.api.loginVerify({ challenge_id: discoverable.challenge_id, response })).user.id, f.users.owner.id);
  const unknown = await f.api.loginOptions({ email: 'unknown@example.invalid' }); f.setCurrent(unknown);
  await t.assert.rejects(() => f.api.loginVerify({ challenge_id: unknown.challenge_id, response }), { code: 'INVALID_CREDENTIALS' });
  const wrong = await f.api.loginOptions({ email: f.users.editor.email }); f.setCurrent(wrong);
  await t.assert.rejects(() => f.api.loginVerify({ challenge_id: wrong.challenge_id, response }), { code: 'INVALID_CREDENTIALS' });
});

test('failed registration cannot persist a credential or reuse its challenge', async t => {
  const f = await fixture(t); f.setValid(false);
  const a = await f.api.registrationOptions(f.users.owner); f.setCurrent(a);
  const input = { challenge_id: a.challenge_id, response: { id: f.credentialId } };
  await t.assert.rejects(() => f.api.registrationVerify(f.users.owner, input), { code: 'INVALID_CREDENTIALS' });
  t.assert.equal((await f.api.credentials(f.users.owner)).length, 0);
  f.setValid(true);
  await t.assert.rejects(() => f.api.registrationVerify(f.users.owner, input), { code: 'INVALID_CREDENTIALS' });
});

test('deletion with a remaining credential revokes its sessions and records audit', async t => {
  const f = await fixture(t); const first = await f.registration();
  const a = await f.api.loginOptions({ email: f.users.owner.email }); f.setCurrent(a);
  const login = await f.api.loginVerify({ challenge_id: a.challenge_id, response: { id: f.credentialId } });
  const second = randomUUID();
  await f.db.run(`INSERT INTO webauthn_credentials
    (id, user_id, credential_id, public_key, sign_count, transports, name, backup_eligible, backup_state, user_verified, created_at)
    SELECT ?, user_id, ?, public_key, sign_count, transports, name, backup_eligible, backup_state, user_verified, created_at
    FROM webauthn_credentials WHERE id = ?`, second, 'second-synthetic-key', first.id);
  await f.api.manageCredential(f.users.owner, first.id, null);
  t.assert.equal((await f.api.credentials(f.users.owner)).length, 1);
  t.assert.ok((await f.db.get('SELECT * FROM sessions WHERE token_hash = ?', tokenHash(login.token))).revoked_at);
  t.assert.equal((await f.db.get("SELECT * FROM auth_events WHERE event = 'webauthn.delete'")).outcome, 'success');
});

test('verification requires challenge_id separately from the browser response; expired login fails', async t => {
  const f = await fixture(t); await f.registration();
  const response = { id: f.credentialId };
  await t.assert.rejects(() => f.api.registrationVerify(f.users.owner, { response }), { code: 'VALIDATION_ERROR' });
  await t.assert.rejects(() => f.api.loginVerify({ response }), { code: 'VALIDATION_ERROR' });
  const options = await f.api.loginOptions({ email: f.users.owner.email });
  f.advance(300000);
  await t.assert.rejects(() => f.api.loginVerify({ challenge_id: options.challenge_id, response }), { code: 'INVALID_CREDENTIALS' });
});

test('public login verification is rate limited before consuming a challenge', async t => {
  const f = await fixture(t);
  const request = requestListener(createServer(f.db, { webauthn: f.options }));
  for (let i = 0; i < 10; i++) {
    t.assert.equal((await request('/api/auth/webauthn/login/verify', { method: 'POST', body: {} })).status, 400);
  }
  const blocked = await request('/api/auth/webauthn/login/verify', { method: 'POST', body: {} });
  t.assert.equal(blocked.status, 429);
  t.assert.equal(blocked.headers['set-cookie'], undefined);
});

test('registration verification rejects a session revoked while the challenge is in flight', async t => {
  const f = await fixture(t);
  const session = await f.db.get('SELECT id FROM sessions WHERE user_id = ?', f.users.owner.id);
  const user = { ...f.users.owner, session_id: session.id };
  const options = await f.api.registrationOptions(user);
  await f.db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', new Date().toISOString(), session.id);
  await t.assert.rejects(() => f.api.registrationVerify(user, { challenge_id: options.challenge_id, response: { id: f.credentialId } }), { code: 'AUTH_REQUIRED' });
  t.assert.equal((await f.api.credentials(user)).length, 0);
});
