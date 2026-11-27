import { RepositoryError } from './repository.mjs';

export const DEFAULT_RETENTION = Object.freeze({
  expiredSessionsDays: 30,
  authEventsDays: 90,
  signupRequestsDays: 30,
});

const positive = (value, fallback) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
};

export function retentionPolicy(env = process.env) {
  return {
    expiredSessionsDays: positive(env.RETENTION_EXPIRED_SESSIONS_DAYS, DEFAULT_RETENTION.expiredSessionsDays),
    authEventsDays: positive(env.RETENTION_AUTH_EVENTS_DAYS, DEFAULT_RETENTION.authEventsDays),
    signupRequestsDays: positive(env.RETENTION_SIGNUP_REQUESTS_DAYS, DEFAULT_RETENTION.signupRequestsDays),
  };
}

const isoBefore = (now, days) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

export async function planRetention(db, { now = new Date(), policy = DEFAULT_RETENTION } = {}) {
  const sessionCutoff = isoBefore(now, policy.expiredSessionsDays);
  const authCutoff = isoBefore(now, policy.authEventsDays);
  const signupCutoff = isoBefore(now, policy.signupRequestsDays);
  const counts = {
    expiredSessions: Number((await db.get(`SELECT COUNT(*) AS total FROM sessions
      WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
         OR (revoked_at IS NULL AND expires_at < ?)`, sessionCutoff, sessionCutoff)).total),
    authEvents: Number((await db.get('SELECT COUNT(*) AS total FROM auth_events WHERE created_at < ?', authCutoff)).total),
    closedSignupRequests: Number((await db.get(`SELECT COUNT(*) AS total FROM signup_requests
      WHERE status <> 'pending' AND decided_at IS NOT NULL AND decided_at < ?`, signupCutoff)).total),
  };
  return {
    policy,
    cutoffs: { sessions: sessionCutoff, authEvents: authCutoff, signupRequests: signupCutoff },
    counts,
    // auth_events is protected by an append-only trigger in both drivers.
    // Retention for this table requires an explicit schema/security decision.
    blocked: { authEvents: 'append-only trigger; no deletion in this procedure' },
  };
}

export async function applyRetention(db, plan, { apply = false } = {}) {
  if (!apply) return { ...plan, applied: false };
  const { cutoffs } = plan;
  const deleted = await db.transaction(async tx => {
    const sessions = Number((await tx.run(`DELETE FROM sessions
      WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
         OR (revoked_at IS NULL AND expires_at < ?)`, cutoffs.sessions, cutoffs.sessions)).rowCount || 0);
    // Never bypass append-only auth_events from a retention job.
    const authEvents = 0;
    const signupRequests = Number((await tx.run(`DELETE FROM signup_requests
      WHERE status <> 'pending' AND decided_at IS NOT NULL AND decided_at < ?`, cutoffs.signupRequests)).rowCount || 0);
    return { expiredSessions: sessions, authEvents, closedSignupRequests: signupRequests };
  });
  return { ...plan, applied: true, deleted };
}

export function parseRetentionArgs(argv = []) {
  const apply = argv.includes('--apply');
  if (apply && !argv.includes('--confirm')) {
    throw new RepositoryError(400, 'Refusing to delete data without --confirm.', 'CONFIRMATION_REQUIRED');
  }
  return { apply };
}

export function printRetention(result) {
  console.log(JSON.stringify({
    applied: Boolean(result.applied),
    policy: result.policy,
    cutoffs: result.cutoffs,
    counts: result.counts,
    deleted: result.deleted || null,
    blocked: result.blocked || null,
  }));
}
