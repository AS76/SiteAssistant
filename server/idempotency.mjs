import { RepositoryError, createTask } from './repository.mjs';

const route = 'POST /api/tasks';

function replay(row, requestHash) {
  if (row.route !== route || row.request_hash !== requestHash) {
    throw new RepositoryError(409, 'Idempotency key was already used for another request.', 'IDEMPOTENCY_KEY_REUSED');
  }
  return { status: row.status, body: JSON.parse(row.body) };
}

export async function createTaskResponse(db, input, { key, requestHash } = {}) {
  if (key === undefined) return { status: 201, body: await createTask(db, input) };
  const previous = await db.get('SELECT * FROM idempotency_keys WHERE key = ?', key);
  if (previous) return replay(previous, requestHash);
  try {
    return await db.transaction(async tx => {
      // Reserve the primary key before creating the task. The reservation and
      // final response commit together, so no incomplete response is visible.
      await tx.run(`INSERT INTO idempotency_keys (key, route, request_hash, status, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`, key, route, requestHash, 201, '', new Date().toISOString());
      const body = await createTask(tx, input);
      await tx.run('UPDATE idempotency_keys SET body = ? WHERE key = ?', JSON.stringify(body), key);
      return { status: 201, body };
    });
  } catch (error) {
    // PostgreSQL aborts the transaction on a uniqueness violation; read the
    // winner only after the losing transaction has been rolled back.
    if (db.isUniqueViolation(error)) {
      const winner = await db.get('SELECT * FROM idempotency_keys WHERE key = ?', key);
      if (winner) return replay(winner, requestHash);
    }
    throw error;
  }
}
