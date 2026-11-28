import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fail, invalid, requireUser, text, uuid, validateInput } from './place-asset-scope.mjs';

const readers = ['owner', 'editor', 'verifier', 'viewer'];
const reviewers = ['owner', 'editor'];
const owners = ['owner'];
const batchMissing = () => fail(404, 'RECONCILIATION_NOT_FOUND', 'Reconciliation batch not found.');
const conflict = (code, message) => fail(409, code, message);
const encode = value => JSON.stringify(value);
const digest = value => createHash('sha256').update(encode(value)).digest('hex');

// SQLite connections in the same process must yield while another writer finishes.
export async function reconciliationTransaction(db, operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(operation);
    } catch (error) {
      if ((error?.errcode & 255) !== 5 || attempt >= 9) throw error;
      await delay(Math.min(10 * 2 ** attempt, 100));
    }
  }
}

async function adoption({ tx, site, module }) {
  const row = await tx.get('SELECT enabled, revision FROM reconciliation_adoptions WHERE site_id = ? AND module = ?', site, module);
  return { enabled: Boolean(row?.enabled), revision: row?.revision ?? 0 };
}

async function setAdoption(ctx, enabled) {
  const { tx, site, module, at, user } = ctx;
  const current = await adoption(ctx);
  if (current.enabled === enabled) return current;
  const revision = current.revision + 1;
  await tx.run(`INSERT INTO reconciliation_adoptions (site_id, module, enabled, revision, changed_at, changed_by)
    VALUES (?, ?, ${enabled ? 'TRUE' : 'FALSE'}, ?, ?, ?) ON CONFLICT (site_id, module) DO UPDATE SET
      enabled = excluded.enabled, revision = excluded.revision, changed_at = excluded.changed_at, changed_by = excluded.changed_by`,
  site, module, revision, at, user.id);
  return { enabled, revision };
}

function occurrences(input, fields, normalize) {
  if (!Array.isArray(input) || !input.length || input.length > 50) invalid('Provide between 1 and 50 occurrences.');
  const unique = new Map();
  for (const item of input) {
    validateInput(item, ['recordId', 'field', ...fields]);
    const occurrence = { recordId: uuid(item.recordId, 'recordId'), field: text(item.field, 'field') };
    const key = encode([occurrence.recordId, occurrence.field]);
    if (unique.has(key)) invalid('Duplicate occurrence.');
    unique.set(key, { ...occurrence, ...normalize(item, occurrence) });
  }
  return [...unique.keys()].sort().map(key => unique.get(key));
}

function revision(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid('Invalid preview revision.');
  return value;
}

function summarize(items) {
  const counts = { total: items.length, matched: 0, applied: 0, unresolved: 0, stale: 0, conflicting: 0 };
  for (const { status } of items) {
    counts[status]++;
    if (status === 'applied') counts.matched++;
  }
  return { counts, items };
}

const publicBatch = row => ({
  id: row.id, decidedAt: row.decided_at, decidedBy: row.decided_by,
  appliedAt: row.applied_at, appliedBy: row.applied_by, rolledBackAt: row.rolled_back_at, rolledBackBy: row.rolled_back_by,
  status: row.rolled_back_at ? 'rolled_back' : row.applied_at ? 'applied' : 'decided',
  apply: JSON.parse(row.apply_result), rollback: JSON.parse(row.rollback_result),
});

// The module owns occurrence snapshots, candidate rules and typed writes. Adapter writes
// run under the site lock in the same transaction as the decision receipts.
export function createReconciliation(module, adapter) {
  const batchReaders = adapter.batchReaders ?? reviewers;
  const withContext = (db, siteId, user, roles, operation, write = true) => {
    requireUser(user);
    const site = uuid(siteId, 'siteId');
    return reconciliationTransaction(db, async tx => {
      await adapter.authorize(tx, site, user, roles);
      if (write) {
        await tx.run('UPDATE sites SET id = id WHERE id = ?', site);
        await adapter.authorize(tx, site, user, roles);
      }
      return await operation({ tx, site, module, user, at: new Date().toISOString() });
    });
  };

  const readBatch = async ({ tx, site }, id, required = true) => {
    const row = await tx.get('SELECT * FROM reconciliation_batches WHERE site_id = ? AND module = ? AND id = ?', site, module, id);
    if (!row && required) batchMissing();
    return row;
  };

  const readItems = async ({ tx, site }, id) => await tx.all(`SELECT * FROM reconciliation_items
    WHERE site_id = ? AND module = ? AND batch_id = ? ORDER BY record_id, field`, site, module, id);

  return {
    preview: (db, site, input, user) => withContext(db, site, user, readers, async ctx => {
      validateInput(input, ['occurrences']);
      const selected = occurrences(input.occurrences, [], () => ({}));
      const items = [];
      for (const occurrence of selected) {
        const source = await adapter.source(ctx, occurrence);
        if (!source) fail(404, 'RECONCILIATION_SOURCE_NOT_FOUND', 'Source occurrence not found.');
        const candidates = await adapter.candidates(ctx, source);
        items.push({ ...occurrence, revision: digest(source), source, candidates,
          status: source.link ? 'matched' : 'unresolved' });
      }
      return { adoption: await adoption(ctx), ...summarize(items) };
    }, false),

    activate: (db, site, user) => withContext(db, site, user, owners, ctx => setAdoption(ctx, true)),

    decide: (db, site, input, user) => withContext(db, site, user, reviewers, async ctx => {
      validateInput(input, ['batchId', 'decisions']);
      const id = uuid(input.batchId, 'batchId');
      const decisions = occurrences(input.decisions, ['revision', 'decision'], (item, occurrence) => ({
        revision: revision(item.revision), decision: adapter.validateDecision(item.decision, occurrence),
      }));
      const hash = digest(decisions);
      const prior = await readBatch(ctx, id, false);
      if (prior) {
        if (prior.decision_hash !== hash) conflict('RECONCILIATION_DECISION_CONFLICT', 'Batch already has different decisions.');
        return publicBatch(prior);
      }
      const active = await adoption(ctx);
      if (!active.enabled) conflict('RECONCILIATION_DISABLED', 'The site owner must activate reconciliation.');
      await adapter.lockSources?.(ctx, decisions);
      const { tx, site: siteId, at } = ctx;
      await tx.run(`INSERT INTO reconciliation_batches
        (site_id, module, id, adoption_revision, decision_hash, decided_at, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      siteId, module, id, active.revision, hash, at, user.id);

      const prepared = [];
      for (const item of decisions) {
        const source = await adapter.source(ctx, item);
        if (!source || digest(source) !== item.revision) {
          conflict('RECONCILIATION_STALE', 'The source changed. Create a new preview.');
        }
        const target = await adapter.prepare(ctx, item.decision, source);
        prepared.push({ ...item, source, target });
        await tx.run(`INSERT INTO reconciliation_items
          (site_id, module, batch_id, record_id, field, source_revision, source_snapshot, decision, target_snapshot)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, siteId, module, id, item.recordId, item.field,
        item.revision, encode(source), encode(item.decision), target && encode(target));
      }
      await adapter.validatePrepared?.(ctx, prepared);
      return publicBatch(await readBatch(ctx, id));
    }),

    list: (db, site, recordId, user) => withContext(db, site, user, batchReaders, async ctx => {
      const rows = await ctx.tx.all(`SELECT b.* FROM reconciliation_batches b WHERE b.site_id = ? AND b.module = ?
        AND EXISTS (SELECT 1 FROM reconciliation_items i WHERE i.site_id = b.site_id AND i.module = b.module
          AND i.batch_id = b.id AND i.record_id = ?) ORDER BY b.decided_at DESC, b.id LIMIT 20`,
      ctx.site, module, uuid(recordId, 'recordId'));
      return rows.map(publicBatch);
    }, false),

    read: (db, site, batchId, user) => withContext(db, site, user, batchReaders, async ctx => {
      const row = await readBatch(ctx, uuid(batchId, 'batchId'));
      const items = (await readItems(ctx, row.id)).map(item => ({
        recordId: item.record_id, field: item.field, revision: item.source_revision, source: JSON.parse(item.source_snapshot),
        decision: JSON.parse(item.decision), target: JSON.parse(item.target_snapshot),
      }));
      return { ...publicBatch(row), items };
    }, false),

    apply: (db, site, batchId, user) => withContext(db, site, user, reviewers, async ctx => {
      const batch = await readBatch(ctx, uuid(batchId, 'batchId'));
      if (batch.apply_result !== null) return JSON.parse(batch.apply_result);
      const active = await adoption(ctx);
      if (!active.enabled || active.revision !== batch.adoption_revision) {
        conflict('RECONCILIATION_DISABLED', 'The batch requires a decision in the current activation.');
      }
      const { tx, site: siteId } = ctx;
      await adapter.authorize(tx, siteId, { id: batch.decided_by }, reviewers);
      const rows = await readItems(ctx, batch.id);
      await adapter.lockSources?.(ctx, rows.map(row => ({ recordId: row.record_id })));
      const { at } = ctx;
      const items = [];
      for (const row of rows) {
        const item = { recordId: row.record_id, field: row.field };
        const source = await adapter.source(ctx, item);
        const decision = JSON.parse(row.decision);
        let outcome;
        if (!source || digest(source) !== row.source_revision) {
          outcome = { status: 'stale' };
        } else if (decision.action === 'unresolved') {
          outcome = { status: 'unresolved' };
        }
        items.push({ ...item, source, decision, target: outcome ? null : JSON.parse(row.target_snapshot), outcome });
      }

      await adapter.validateApply?.(ctx, items);
      const results = [];
      for (const { recordId, field, source, decision, target, outcome: rejected } of items) {
        const item = { recordId, field };
        const outcome = rejected ?? await adapter.apply(ctx, item, batch.id, source, decision, target);
        if (outcome.status === 'applied') {
          await tx.run(`UPDATE reconciliation_items SET applied_at = ? WHERE site_id = ? AND module = ?
            AND batch_id = ? AND record_id = ? AND field = ?`, at, siteId, module, batch.id, item.recordId, item.field);
        }
        results.push({ ...item, ...outcome });
      }
      const result = { batchId: batch.id, ...summarize(results) };
      await tx.run(`UPDATE reconciliation_batches SET applied_at = ?, applied_by = ?, apply_result = ?
        WHERE site_id = ? AND module = ? AND id = ?`, at, user.id, encode(result), siteId, module, batch.id);
      return result;
    }),

    rollback: (db, site, batchId, input, user) => withContext(db, site, user, owners, async ctx => {
      validateInput(input, ['reason']);
      const reason = text(input.reason, 'reason', { max: 2000 });
      const batch = await readBatch(ctx, uuid(batchId, 'batchId'));
      if (batch.rollback_result !== null) {
        const prior = JSON.parse(batch.rollback_result);
        if (prior.reason !== reason) conflict('RECONCILIATION_DECISION_CONFLICT', 'Batch already has a different rollback decision.');
        return prior;
      }
      if (!batch.applied_at) conflict('RECONCILIATION_NOT_APPLIED', 'Apply the batch before rolling it back.');
      const { tx, site: siteId, at } = ctx;
      const disabled = await setAdoption(ctx, false);
      const applied = new Map(JSON.parse(batch.apply_result).items.map(item => [encode([item.recordId, item.field]), item]));
      const items = [];
      for (const row of await readItems(ctx, batch.id)) {
        if (!row.applied_at) continue;
        const item = { recordId: row.record_id, field: row.field };
        const outcome = await adapter.compensate(ctx, item, batch.id, reason, applied.get(encode([item.recordId, item.field])));
        items.push({ ...item, ...outcome });
      }
      const result = { batchId: batch.id, reason, adoption: disabled, items,
        counts: { compensated: items.filter(item => item.status === 'compensated').length,
          conflicting: items.filter(item => item.status === 'conflicting').length } };
      await tx.run(`UPDATE reconciliation_batches SET rolled_back_at = ?, rolled_back_by = ?, rollback_result = ?
        WHERE site_id = ? AND module = ? AND id = ?`, at, user.id, encode(result), siteId, module, batch.id);
      return result;
    }),
  };
}
