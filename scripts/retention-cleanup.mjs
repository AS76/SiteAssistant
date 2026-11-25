import { openDb, closeDb } from '../server/db.mjs';
import { applyRetention, parseRetentionArgs, planRetention, printRetention, retentionPolicy } from '../server/retention.mjs';

const { apply } = parseRetentionArgs(process.argv.slice(2));
const db = await openDb();
try {
  const plan = await planRetention(db, { policy: retentionPolicy() });
  const result = await applyRetention(db, plan, { apply });
  printRetention(result);
} finally {
  if (db.isOpen) await closeDb(db);
}
