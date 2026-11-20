import { randomBytes, randomUUID } from 'node:crypto';
// Load the production verifier only when passkey functionality is invoked.
const library = () => import('@simplewebauthn/server');
import { tokenHash, SESSION_TTL, publicUser } from './auth.mjs';
import { RepositoryError } from './repository.mjs';

const invalid = () => new RepositoryError(401, 'Passkey verification failed.', 'INVALID_CREDENTIALS');
const validation = () => new RepositoryError(400, 'Invalid passkey request.', 'VALIDATION_ERROR');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = 'id, credential_id, name, transports, created_at, last_used_at';
const bool = value => value ? 1 : 0;

export function createWebAuthn(db, {
  rpID = process.env.WEBAUTHN_RP_ID, origin = process.env.WEBAUTHN_ORIGIN,
  now = Date.now,
  registrationOptions = async options => (await library()).generateRegistrationOptions(options),
  authenticationOptions = async options => (await library()).generateAuthenticationOptions(options),
  verifyRegistration = async options => (await library()).verifyRegistrationResponse(options),
  verifyAuthentication = async options => (await library()).verifyAuthenticationResponse(options),
} = {}) {
  function config() {
    if (!rpID || !origin) throw new RepositoryError(503, 'Passkey authentication is not configured.', 'WEBAUTHN_NOT_CONFIGURED');
  }
  async function audit(tx, userId, event, outcome, context = {}) {
    await tx.run(`INSERT INTO auth_events (id, user_id, event, outcome, ip, user_agent, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), userId || null, event, outcome,
    String(context.ip || '').slice(0, 100), String(context.userAgent || '').slice(0, 1000), '{}', new Date(now()).toISOString());
  }
  async function challenge(options, userId, kind, unknown = false) {
    const id = randomUUID(), at = now();
    await db.run(`INSERT INTO webauthn_challenges (id, user_id, kind, challenge_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`, id, userId, kind, (unknown ? 'unknown:' : '') + tokenHash(options.challenge), new Date(at + 300000).toISOString(), new Date(at).toISOString());
    return { ...options, challenge_id: id };
  }
  async function consume(input, kind, userId) {
    if (!input || typeof input.challenge_id !== 'string' || !uuid.test(input.challenge_id) ||
        !input.response || typeof input.response !== 'object' || typeof input.response.id !== 'string') throw validation();
    // Consumption commits before crypto verification, including on failed attempts.
    const at = new Date(now()).toISOString();
    const row = await db.get(`UPDATE webauthn_challenges SET used_at = ?
      WHERE id = ? AND kind = ? AND used_at IS NULL AND expires_at > ? RETURNING *`, at, input.challenge_id, kind, at);
    if (!row || (userId && row.user_id !== userId)) throw invalid();
    return row;
  }
  async function lockUser(tx, id, sessionId) {
    const user = await tx.get('UPDATE users SET id = id WHERE id = ? AND disabled_at IS NULL RETURNING *', id);
    if (!user) throw invalid();
    if (sessionId && !await tx.get(`SELECT id FROM sessions WHERE id = ? AND user_id = ?
      AND revoked_at IS NULL AND expires_at > ?`, sessionId, id, new Date(now()).toISOString())) {
      throw new RepositoryError(401, 'A valid session is required.', 'AUTH_REQUIRED');
    }
    return user;
  }
  return {
    async registrationOptions(user) {
      config();
      const credentials = await db.all('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?', user.id);
      return challenge(await registrationOptions({ rpName: 'SiteAssistant', rpID,
        userID: Buffer.from(user.id), userName: user.email, attestationType: 'none',
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        excludeCredentials: credentials.map(c => ({ id: c.credential_id, transports: JSON.parse(c.transports) })),
      }), user.id, 'registration');
    },
    async registrationVerify(user, input, context) {
      config();
      if (user.session_id && !await db.get(`SELECT id FROM sessions WHERE id = ? AND user_id = ?
        AND revoked_at IS NULL AND expires_at > ?`, user.session_id, user.id, new Date(now()).toISOString())) {
        throw new RepositoryError(401, 'A valid session is required.', 'AUTH_REQUIRED');
      }
      try {
        const row = await consume(input, 'registration', user.id);
        const result = await verifyRegistration({ response: input.response, expectedChallenge: value => tokenHash(value) === row.challenge_hash,
          expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
        if (!result.verified || !result.registrationInfo?.userVerified) throw invalid();
        const info = result.registrationInfo, credential = info.credential, id = randomUUID();
        await db.transaction(async tx => {
          await lockUser(tx, user.id, user.session_id);
          await tx.run(`INSERT INTO webauthn_credentials
            (id, user_id, credential_id, public_key, sign_count, transports, aaguid, name, attestation_type,
             backup_eligible, backup_state, user_verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, user.id, credential.id, Buffer.from(credential.publicKey), credential.counter,
          JSON.stringify(credential.transports || []), info.aaguid || null, 'Passkey', info.fmt || null,
          bool(info.credentialDeviceType === 'multiDevice'), bool(info.credentialBackedUp), bool(info.userVerified), new Date(now()).toISOString());
          await audit(tx, user.id, 'webauthn.registration', 'success', context);
        });
        return { id, name: 'Passkey' };
      } catch (error) {
        await audit(db, user.id, 'webauthn.registration', 'failure', context);
        if (error instanceof RepositoryError) throw error;
        throw invalid();
      }
    },
    async loginOptions(input = {}) {
      config();
      if (input.discoverable !== undefined && typeof input.discoverable !== 'boolean') throw validation();
      if (input.email !== undefined && (typeof input.email !== 'string' || !input.email.trim() || input.email.length > 254)) throw validation();
      if (!input.discoverable && !input.email) throw validation();
      const user = input.discoverable ? null : await db.get('SELECT id FROM users WHERE lower(email) = ? AND disabled_at IS NULL', input.email.trim().toLowerCase());
      const credentials = user ? await db.all('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?', user.id) : [];
      // Unknown accounts receive the same options shape; they cannot authenticate as another user.
      const allowCredentials = input.discoverable ? [] : credentials.length ? credentials.map(c => ({ id: c.credential_id, transports: JSON.parse(c.transports) }))
        : [{ id: randomBytes(32).toString('base64url') }];
      return challenge(await authenticationOptions({ rpID, userVerification: 'required', allowCredentials }),
        user?.id || null, 'authentication', !input.discoverable && !user);
    },
    async loginVerify(input, context = {}) {
      config();
      let userId = null;
      try {
        const row = await consume(input, 'authentication');
        const credential = await db.get('SELECT * FROM webauthn_credentials WHERE credential_id = ?', input.response.id);
        if (row.challenge_hash.startsWith('unknown:')) throw invalid();
        if (!credential || (row.user_id && credential.user_id !== row.user_id)) throw invalid();
        // Non-discoverable unknown-user requests must never become a login for another account.
        const handle = input.response.response?.userHandle;
        if (handle && handle !== Buffer.from(credential.user_id).toString('base64url')) throw invalid();
        if (!row.user_id && (!handle || handle !== Buffer.from(credential.user_id).toString('base64url'))) throw invalid();
        userId = credential.user_id;
        const result = await verifyAuthentication({ response: input.response,
          expectedChallenge: value => tokenHash(value) === row.challenge_hash, expectedOrigin: origin, expectedRPID: rpID,
          requireUserVerification: true, credential: { id: credential.credential_id, publicKey: new Uint8Array(credential.public_key),
            counter: Number(credential.sign_count), transports: JSON.parse(credential.transports) } });
        if (!result.verified || !result.authenticationInfo?.userVerified) throw invalid();
        const token = randomBytes(32).toString('base64url'), at = new Date(now()).toISOString();
        const user = await db.transaction(async tx => {
          const user = await lockUser(tx, userId);
          const updated = await tx.run(`UPDATE webauthn_credentials SET sign_count = ?, last_used_at = ?, backup_state = ?, user_verified = ?
            WHERE id = ? AND sign_count = ?`, result.authenticationInfo.newCounter, at, bool(result.authenticationInfo.credentialBackedUp), 1, credential.id, credential.sign_count);
          if (!updated.rowCount) throw invalid();
          await tx.run(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, ip, user_agent,
            auth_method, assurance, last_seen_at, credential_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          randomUUID(), userId, tokenHash(token), at, new Date(now() + SESSION_TTL).toISOString(),
          String(context.ip || '').slice(0, 100), String(context.userAgent || '').slice(0, 1000), 'webauthn', 'passkey', at, credential.id);
          await audit(tx, userId, 'webauthn.authentication', 'success', context);
          return user;
        });
        return { token, user: publicUser(user), assurance: 'passkey' };
      } catch (error) {
        await audit(db, userId, 'webauthn.authentication', 'failure', context);
        if (error instanceof RepositoryError) throw error;
        throw invalid();
      }
    },
    async credentials(user) {
      const rows = await db.all(`SELECT ${fields} FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at, id`, user.id);
      return rows.map(row => ({ ...row, transports: JSON.parse(row.transports) }));
    },
    async manageCredential(user, id, input, context) {
      if (!uuid.test(id)) throw validation();
      if (input !== null && (typeof input?.name !== 'string' || !input.name.trim() || input.name.trim().length > 100)) throw validation();
      return db.transaction(async tx => {
        await lockUser(tx, user.id, user.session_id);
        const credential = await tx.get('SELECT id FROM webauthn_credentials WHERE id = ? AND user_id = ?', id, user.id);
        if (!credential) throw new RepositoryError(404, 'Credential not found.', 'NOT_FOUND');
        if (input === null) {
          const credentials = await tx.all('SELECT id FROM webauthn_credentials WHERE user_id = ?', user.id);
          if (credentials.length <= 1) throw new RepositoryError(409, 'The last usable credential cannot be removed.', 'LAST_CREDENTIAL');
          await tx.run('DELETE FROM webauthn_credentials WHERE id = ?', id);
          await tx.run('UPDATE sessions SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL', new Date(now()).toISOString(), id);
        } else await tx.run('UPDATE webauthn_credentials SET name = ? WHERE id = ?', input.name.trim(), id);
        await audit(tx, user.id, input === null ? 'webauthn.delete' : 'webauthn.rename', 'success', context);
        return { id };
      });
    },
  };
}
