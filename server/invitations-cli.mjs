import { randomUUID } from 'node:crypto';
import { closeDb, openDb } from './db.mjs';
import { sendMail, MailNotConfiguredError } from './auth-mail.mjs';
import { listInvitations, reissueInvitation, retryInvitation, revokeInvitation } from './invitations.mjs';
import { RepositoryError } from './repository.mjs';

const actions = {
  list: db => listInvitations(db),
  retry: retryInvitation,
  reissue: reissueInvitation,
  revoke: (db, target) => revokeInvitation(db, target, null),
};

let db;
const [action, target, ...extra] = process.argv.slice(2);
try {
  if (!Object.hasOwn(actions, action) || extra.length || (action === 'list' ? target !== undefined : !target)) {
    throw new RepositoryError(400, 'Usage: npm run invitations -- list | retry|reissue|revoke <id|email>', 'INVALID_COMMAND');
  }
  db = await openDb();
  const result = await actions[action](db, target, { mailer: sendMail, publicUrl: process.env.PUBLIC_URL });
  console.log(JSON.stringify(result));
  if (result.delivery_status === 'failed' || (action !== 'revoke' && result.revoked_at)) process.exitCode = 1;
} catch (error) {
  if (error instanceof RepositoryError || error instanceof MailNotConfiguredError) {
    if (db) {
      await db.run(`INSERT INTO auth_events (id, event, outcome, detail_json, created_at)
        VALUES (?, 'invitation_command_rejected', 'failure', ?, ?)`, randomUUID(),
      JSON.stringify({ source: 'cli', action, code: error.code }), new Date().toISOString())
        .catch(() => console.error('Unable to audit rejected invitation command.'));
    }
    console.error(error.message);
  } else {
    console.error('Invitation command failed. Check delivery status with list.');
  }
  process.exitCode = 1;
} finally {
  if (db) await closeDb(db).catch(() => { console.error('Unable to close database.'); process.exitCode = 1; });
}
