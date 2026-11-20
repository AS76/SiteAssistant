import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from '../server/http.mjs';
import { applyMigration } from '../server/migrations/index.mjs';
import { importDeviationWorkbook } from '../server/planning-import.mjs';
import {
  importDeviations, getDeviation, listDeviations, listDeviationEvents, latestDeviationImports, updateDeviationOwner,
} from '../server/deviations.mjs';
import { createAttachment, deleteAttachment, getAttachment, createSite, createTask, getTask, listTasks } from '../server/repository.mjs';
import { writeWorkbook } from '../server/xlsx-write.mjs';
import { apply as seedDemo, reset as resetDemo } from '../server/seed-demo.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { deviationsDatabase, deviationsSource } from './helpers/deviations.mjs';
import { MemoryObjectStorage } from './helpers/object-storage.mjs';
import { wbsDatabase } from './helpers/wbs.mjs';

const at = '2026-11-01T08:00:00.000Z';
const sha = value => createHash('sha256').update(value).digest('hex');
const fileContent = Buffer.from('%PDF synthetic record');
const fileInput = (entity_type, entity_id) => ({
  entity_type, entity_id, filename: 'synthetic.pdf', content_type: 'application/pdf', data_base64: fileContent.toString('base64'),
});
const taskInput = siteId => ({ siteId, title: 'Synthetic check', executor: 'Example crew', verifier: 'Example reviewer' });

for (const driver of ['sqlite', 'pg']) {
  const options = { skip: driver === 'pg' && process.env.WBS_REAL_PG !== '1' && 'Requires a local PostgreSQL test database' };
  test(`038 upgrades populated ${driver} and preserves history, attachments and inbound references`, options, async t => {
    const db = await wbsDatabase(t, driver, { beforeOperational: true });
    for (const file of ['036_wbs_operational.sql', '037_wbs_source_scope_backfill.sql']) {
      await db.transaction(tx => applyMigration(tx, file, { driver }));
    }
    const site = await createSite(db, { code: 'SYN-UPGRADE', name: 'Synthetic upgrade' });
    const { users } = await authFixture(db, site);
    const deviation = randomUUID(), hse = randomUUID(), impact = randomUUID();
    const task = await createTask(db, taskInput(site.id));
    await db.run("UPDATE tasks SET status = 'closed' WHERE id = ?", task.id);
    await db.run(`INSERT INTO task_events (task_id, at, actor, from_status, to_status, action)
      VALUES (?, ?, 'Example reviewer', 'to_verify', 'closed', 'verify')`, task.id, at);
    await db.run(`INSERT INTO deviations (id, site_id, deviation_no, title, status, created_at)
      VALUES (?, ?, 'SYN-01', 'Synthetic legacy deviation', 'open', ?)`, deviation, site.id, at);
    await db.run("INSERT INTO deviation_links VALUES (?, 'task', ?)", deviation, task.id);
    await db.run(`INSERT INTO cost_impacts (id, site_id, title, status, created_at)
      VALUES (?, ?, 'Synthetic impact', 'open', ?)`, impact, site.id, at);
    await db.run('INSERT INTO cost_impact_deviations VALUES (?, ?)', impact, deviation);
    await db.run(`INSERT INTO hse_events (id, site_id, type, severity, occurred_on, deviation_id, created_at, updated_at, deleted_at)
      VALUES (?, ?, 'observation', 'low', '2026-11-01', ?, ?, ?, ?)`, hse, site.id, deviation, at, at, at);
    const storage = new MemoryObjectStorage();
    const attachment = await createAttachment(db, fileInput('task', task.id), users.owner, storage);
    await db.run(`INSERT INTO audit_events (id, site_id, entity_type, entity_id, action, at, actor, changes)
      VALUES (?, ?, 'hse_event', ?, 'update', ?, ?, '{}')`, randomUUID(), site.id, hse, at, users.owner.id);
    const tables = ['sites', 'tasks', 'task_events', 'deviations', 'deviation_links', 'cost_impact_deviations', 'hse_events', 'attachments', 'audit_events'];
    const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async table =>
      [table, await db.all(`SELECT * FROM ${table} ORDER BY 1`)])));
    const before = await snapshot();
    await db.transaction(tx => applyMigration(tx, '038_identity_evidence.sql', { driver }));
    const after = await snapshot();
    for (const table of tables) {
      assert.equal(after[table].length, before[table].length);
      for (let i = 0; i < before[table].length; i++) {
        for (const [key, value] of Object.entries(before[table][i])) assert.deepEqual(after[table][i][key], value, `${table}.${key}`);
      }
    }
    if (driver === 'sqlite') assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
    await assert.rejects(() => db.run('DELETE FROM deviations WHERE id = ?', deviation), /foreign key/i);
    assert.equal((await getDeviation(db, deviation)).traceability, 'none');
    assert.equal((await getDeviation(db, deviation)).absence, 'unknown');
    const legacy = await getTask(db, task.id);
    assert.equal(legacy.status, 'closed');
    assert.equal(legacy.verified_at, null);
    assert.equal(legacy.acceptance_state, 'none');
    assert.equal(legacy.events.find(event => event.action === 'verify').waiver, false);
    const copy = await getAttachment(db, attachment.id, users.viewer, storage);
    assert.deepEqual(await streamBytes(copy.stream), fileContent);
  });

  test(`deviation identity, presence, governance and append-only history on ${driver}`, options, async t => {
    const db = await deviationsDatabase(t, driver);
    const site = await createSite(db, { code: 'SYN-DEVIATIONS', name: 'Synthetic deviations' });
    const { users, cookies } = await authFixture(db, site);
    const request = requestListener(createServer(db));
    const importPath = '/api/deviations/import';
    const headers = ['source_id', 'deviation_id', 'title', 'status'];
    const row = (id, no, title, status) => [id, no, title, status];
    const workbook = (day, rows, options = {}) => {
      const file = writeWorkbook([headers, ...rows]);
      return { site_id: site.id, filename: 'synthetic.xlsx', data_base64: file.toString('base64'),
        meta: { sourceSystem: 'internal', exportDate: `2026-11-${day}`, fileSha256: sha(file), complete: true, scope: 'Area A', ...options } };
    };
    const apply = (day, rows, options) => importDeviationWorkbook(db, workbook(day, rows, options), users.owner);
    const a = row('SYN-A', 'D-1', '  Synthetic original  ', ' CLOSED ');
    const b = row('SYN-B', 'D-2', 'Synthetic remaining', 'open');
    const first = workbook('10', [a, b]);
    assert.equal((await request(importPath, { method: 'POST', cookie: cookies.owner, body: first })).status, 200);
    assert.equal((await importDeviationWorkbook(db, first, users.owner)).unchanged, true);
    const [old] = await listDeviations(db, { siteId: site.id });
    assert.equal(old.source_id, 'SYN-A');
    assert.equal(old.title, a[2].trim());
    assert.equal(old.source_status, a[3]);
    assert.equal(old.traceability, 'full');
    assert.equal(old.absence_reason, 'single_export');
    assert.equal(old.absence, 'unknown');
    assert.deepEqual(await listDeviationEvents(db, old.id, users.viewer), []);
    await assert.rejects(() => db.run('UPDATE deviations SET source_id = ? WHERE id = ?', 'SYN-ALTERED', old.id), /immutable/i);
    await assert.rejects(() => db.run(`INSERT INTO deviations (id, site_id, source_system, source_id, created_at)
      VALUES (?, ?, 'internal', 'SYN-A', ?)`, randomUUID(), site.id, at), /unique/i);

    const corrupt = workbook('11', [b], { fileSha256: 'a'.repeat(64) });
    await assert.rejects(() => importDeviationWorkbook(db, corrupt, users.owner), { code: 'DEVIATION_EXPORT_CHECKSUM_MISMATCH' });
    await assert.rejects(() => apply('11', [row('SYN-B', 'D-2', 'Synthetic remaining', '01 Open')]), { code: 'UNKNOWN_STATUS' });
    await assert.rejects(() => apply('11', [b, b]), { code: 'DEVIATION_EXPORT_INVALID' });
    await assert.rejects(() => apply('11', [row('', 'D-3', 'Synthetic missing identity', 'open')]), { code: 'DEVIATION_IDENTITY_UNRESOLVED' });
    assert.equal((await getDeviation(db, old.id)).absence_reason, 'single_export');

    await apply('11', [b]);
    assert.deepEqual((await listDeviations(db, { siteId: site.id, absent: true })).map(item => item.id), [old.id]);
    const absent = await getDeviation(db, old.id);
    assert.equal(absent.absence, true);
    assert.equal(absent.absence_export_date, '2026-11-11');
    assert.equal(absent.absence_scope, 'Area A');
    assert.equal(absent.status, 'closed');
    assert.deepEqual(await listDeviationEvents(db, old.id, users.viewer), []);
    assert.equal((await listDeviations(db, { siteId: site.id })).find(item => item.source_id === 'SYN-B').absence, false);

    await apply('12', [], { complete: false });
    assert.equal((await getDeviation(db, old.id)).absence_reason, 'incomplete_export');
    assert.equal((await getDeviation(db, old.id)).absence, 'unknown');
    assert.equal((await latestDeviationImports(db, site.id, users.viewer))[0].export_date, '2026-11-11');
    await apply('13', [a, b], { scope: 'Area B' });
    assert.equal((await getDeviation(db, old.id)).absence_reason, 'different_scope');
    assert.equal((await getDeviation(db, old.id)).absence, 'unknown');
    await apply('14', [b, row('SYN-A', 'D-9', 'Renamed synthetic record', ' in_progress ')], { scope: 'Area B' });
    const renamed = await getDeviation(db, old.id);
    assert.equal(renamed.deviation_no, 'D-9');
    assert.equal(renamed.absence, false);
    assert.equal(renamed.reopen_count, 1);
    assert.equal(renamed.last_seen_in_export_date, '2026-11-14');
    const [reopen] = await listDeviationEvents(db, renamed.id, users.viewer);
    assert.deepEqual([reopen.action, reopen.source, reopen.actor, reopen.actor_id, reopen.from_status, reopen.to_status],
      ['reopen', 'import', 'import', null, 'closed', 'in_progress']);
    await assert.rejects(() => db.run("UPDATE deviation_events SET note = 'modified'"), /append.only/i);
    await assert.rejects(() => db.run('DELETE FROM deviation_events'), /append.only/i);
    await apply('15', [row('SYN-A', 'D-9', 'Renamed synthetic record', 'IN_PROGRESS'), b], { complete: false, scope: 'Area B' });
    assert.equal((await listDeviationEvents(db, old.id, users.viewer)).length, 2);
    assert.equal((await getDeviation(db, old.id)).last_seen_in_export_date, '2026-11-14');
    assert.equal((await getDeviation(db, old.id)).reopen_count, 1);

    const snapshot = await listDeviations(db, { siteId: site.id });
    const exports = await db.all('SELECT * FROM deviation_exports ORDER BY id');
    const events = await listDeviationEvents(db, old.id, users.viewer);
    const failing = { transaction: fn => db.transaction(tx => fn({ ...tx, run: async (sql, ...args) => {
      if (sql.startsWith('INSERT INTO deviation_events') && args[0] !== old.id) throw new Error('Synthetic late event failure');
      return tx.run(sql, ...args);
    } })) };
    await assert.rejects(() => importDeviationWorkbook(failing, workbook('16', [
      row('SYN-A', 'D-9', 'Synthetic close', 'closed'), row('SYN-B', 'D-2', 'Synthetic close', 'closed'),
    ], { scope: 'Area B' }), users.owner), /late event failure/);
    assert.deepEqual(await listDeviations(db, { siteId: site.id }), snapshot);
    assert.deepEqual(await db.all('SELECT * FROM deviation_exports ORDER BY id'), exports);
    assert.deepEqual(await listDeviationEvents(db, old.id, users.viewer), events);

    await apply('16', [row('SYN-A', 'D-9', 'Other source', 'open')], { sourceSystem: 'other' });
    assert.equal((await listDeviations(db, { siteId: site.id })).length, 3);
    const path = `/api/deviations/${old.id}`;
    assert.equal((await request(path + '/owner', { method: 'PATCH', cookie: cookies.viewer, body: { userId: users.viewer.id } })).status, 403);
    assert.equal((await request(path + '/owner', { method: 'PATCH', cookie: cookies.editor, body: { userId: users.viewer.id } })).status, 200);
    assert.equal((await getDeviation(db, old.id)).internal_owner_id, users.viewer.id);
    await assert.rejects(() => updateDeviationOwner(db, old.id, { userId: randomUUID() }, users.owner), { status: 422 });
    assert.equal((await request(path + '/attribution', { method: 'PATCH', cookie: cookies.owner,
      body: { causingCompany: 'Synthetic B', resolvingCompany: 'Synthetic A', attributionState: 'disputed' } })).status, 200);
    const history = (await request(path + '/events', { cookie: cookies.viewer })).body;
    assert.deepEqual(history.slice(-2).map(event => [event.source, event.action, event.actor_id]), [
      ['internal', 'owner', users.editor.id], ['internal', 'attribution', users.owner.id],
    ]);
    assert.equal((await db.all("SELECT * FROM audit_events WHERE entity_type = 'deviation'")).length, 2);
    for (const method of ['PATCH', 'DELETE']) assert.equal((await request(path + '/events', { method, cookie: cookies.owner })).status, 404);
    const latest = await request(`/api/deviation-imports/latest?site_id=${site.id}`, { cookie: cookies.viewer });
    assert.equal(latest.body.find(batch => batch.source_system === 'internal').scope, 'Area B');
    assert.equal(latest.body.find(batch => batch.source_system === 'other').scope, 'Area A');

    const source = await deviationsSource(db, site, [{ deviation_no: 'SYN-SNAPSHOT', source_status: ' Open ' }]);
    await importDeviations(db, site.id, users.owner);
    const legacy = (await listDeviations(db, { siteId: site.id })).find(item => item.deviation_no === 'SYN-SNAPSHOT');
    assert.equal(legacy.source_status, null);
    assert.equal(legacy.traceability, 'none');
    assert.equal(legacy.absence, 'unknown');
    const fileSha256 = (await db.get('SELECT content_sha256 FROM ingest.import_batches WHERE id = ?', source.batchId)).content_sha256;
    await importDeviations(db, site.id, users.owner, { sourceSystem: 'other', fileSha256, exportDate: '2026-11-17', complete: true, scope: 'Synthetic' });
    assert.equal((await getDeviation(db, legacy.id)).source_id, source.rows[0].source_uuid);
  });

  test(`task waiver, verification evidence, attachments and checksum on ${driver}`, async t => {
    const db = await wbsDatabase(t, driver);
    const site = await createSite(db, { code: 'SYN-EVIDENCE', name: 'Synthetic evidence' });
    const { users, cookies } = await authFixture(db, site);
    const storage = new MemoryObjectStorage();
    const request = requestListener(createServer(db, { storage }));
    const task = await createTask(db, { ...taskInput(site.id), verifier_id: users.verifier.id });
    const path = `/api/tasks/${task.id}`;
    const transition = (role, to, extra) => request(path + '/transition', { method: 'POST', cookie: cookies[role], body: { to, ...extra } });
    const accept = (role, extra) => request(path + '/acceptance', { method: 'PATCH', cookie: cookies[role], body: { acceptanceState: 'accepted', ...extra } });
    const upload = (role, type, id) => request('/api/attachments', { method: 'POST', cookie: cookies[role], body: fileInput(type, id) });
    await transition('editor', 'in_progress');
    const declared = await transition('editor', 'to_verify', { note: 'Synthetic execution statement' });
    assert.ok(declared.body.declared_at);
    assert.equal(declared.body.acceptance_state, 'declared');
    const beforeClosure = await getTask(db, task.id);
    const noEvidence = await transition('verifier', 'closed', { note: 'Synthetic verification' });
    assert.equal(noEvidence.status, 422);
    assert.equal(noEvidence.body.code, 'TASK_CLOSURE_EVIDENCE_REQUIRED');
    const reason = 'Synthetic register unavailable during the demonstration.';
    const reasonOnly = await transition('verifier', 'closed', { reason });
    assert.equal(reasonOnly.status, 422);
    assert.equal(reasonOnly.body.code, 'TASK_CLOSURE_EVIDENCE_REQUIRED');
    assert.deepEqual(await getTask(db, task.id), beforeClosure);
    assert.equal((await transition('verifier', 'closed', { waiver: true, reason: 'Too short' })).status, 422);
    assert.equal((await accept('verifier', { documentId: randomUUID() })).status, 422);
    const waived = await transition('verifier', 'closed', { waiver: true, reason });
    assert.equal(waived.status, 200);
    assert.equal(waived.body.verified_at, null);
    assert.equal(waived.body.acceptance_state, declared.body.acceptance_state);
    assert.equal(waived.body.events.at(-1).waiver, true);
    assert.equal(waived.body.events.at(-1).action, 'close');
    assert.deepEqual((await listTasks(db, { siteId: site.id, closedWithWaiver: true })).map(item => item.id), [task.id]);
    const reopened = await transition('verifier', 'in_progress', { reason: 'Synthetic follow-up' });
    assert.equal(reopened.body.reopen_count, 1);
    assert.equal(reopened.body.events.at(-1).action, 'reopen');
    assert.deepEqual(reopened.body.events.slice(0, -1), waived.body.events);
    assert.deepEqual(await listTasks(db, { siteId: site.id, closedWithWaiver: true }), []);
    const uploadTask = await upload('editor', 'task', task.id);
    assert.equal(uploadTask.status, 201);
    await transition('editor', 'to_verify', { note: 'Synthetic resubmission' });
    const verified = await transition('verifier', 'closed', { note: 'Synthetic independent verification' });
    assert.equal(verified.body.events.at(-1).action, 'verify');
    assert.equal(verified.body.events.at(-1).evidence_attachment_id, uploadTask.body.id);
    assert.ok(verified.body.verified_at);
    assert.equal(verified.body.acceptance_state, 'declared');
    await assert.rejects(() => deleteAttachment(db, uploadTask.body.id, users.editor, storage), { code: 'TASK_VERIFICATION_DOCUMENT_IN_USE' });
    assert.equal((await accept('verifier', { documentId: uploadTask.body.id, date: '2026-02-30' })).status, 422);
    assert.equal((await accept('editor', { documentId: uploadTask.body.id, date: '2026-11-17' })).status, 403);
    assert.equal((await accept('verifier', { documentId: uploadTask.body.id, date: '2026-11-17' })).body.acceptance_state, 'accepted');
    const accepted = await getTask(db, task.id);
    assert.equal(accepted.acceptance_document_id, uploadTask.body.id);
    assert.equal(accepted.reopen_count, 1);
    assert.equal(accepted.events.find(event => event.action === 'close').waiver, true);

    const deviation = randomUUID();
    await db.run("INSERT INTO deviations (id, site_id, title, status, created_at) VALUES (?, ?, 'Synthetic deviation', 'open', ?)", deviation, site.id, at);
    assert.equal((await upload('verifier', 'deviation', deviation)).status, 403);
    const attached = await upload('editor', 'deviation', deviation);
    assert.equal(attached.status, 201);
    const listing = `/api/attachments?site_id=${site.id}&entity_type=deviation&entity_id=${deviation}`;
    assert.equal((await request(listing, { cookie: cookies.viewer })).body[0].id, attached.body.id);
    const attachment = await getAttachment(db, attached.body.id, users.viewer, storage);
    assert.deepEqual(await streamBytes(attachment.stream), fileContent);
    const unrelated = await createSite(db, { code: 'SYN-OTHER', name: 'Synthetic other site' });
    await assert.rejects(() => getAttachment(db, attached.body.id, { id: randomUUID() }, storage), { status: 403 });
    assert.notEqual(unrelated.id, site.id);

    const exportPath = `/api/sites/${site.id}/evidence-export`;
    const artifact = await request(exportPath, { cookie: cookies.viewer });
    assert.equal(artifact.status, 200);
    assert.match(artifact.headers['content-type'], /^text\/csv/);
    const digest = artifact.headers['x-content-sha256'];
    assert.equal(sha(artifact.body), digest);
    const text = artifact.body.toString('utf8');
    assert.match(text, /generated_at/);
    assert.match(text, /SYN-EVIDENCE/);
    assert.match(text, /"task","[^"]+"[^\n]*Synthetic check/);
    assert.match(text, /"deviation","[^"]+"[^\n]*Synthetic deviation/);
    assert.match(text, /"attachment","[^"]+"[^\n]*synthetic.pdf/);
    assert.doesNotMatch(text, new RegExp(digest));
    const changed = Buffer.from(artifact.body); changed[0] ^= 1;
    assert.notEqual(sha(changed), digest);
    const sidecarPath = /<([^>]+)>/.exec(artifact.headers.link)[1];
    const paired = new URL(sidecarPath, 'http://example.invalid').searchParams;
    assert.equal(paired.get('checksum'), 'sidecar');
    assert.ok(paired.get('generated_at'));
    assert.equal(paired.get('sha256'), digest);
    const sidecar = await request(sidecarPath, { cookie: cookies.viewer });
    assert.equal(sidecar.status, 200);
    assert.match(sidecar.headers['content-type'], /^text\/plain/);
    assert.equal(sidecar.body.toString('utf8'), digest);
    for (const params of [{}, { generated_at: paired.get('generated_at') }, { sha256: digest }]) {
      const query = new URLSearchParams({ checksum: 'sidecar', ...params });
      const unpaired = await request(`${exportPath}?${query}`, { cookie: cookies.viewer });
      assert.equal(unpaired.status, 400);
      assert.deepEqual(unpaired.body, {
        code: 'VALIDATION_ERROR', error: 'Checksum sidecar requires the paired generated_at and sha256.',
      });
    }
    await db.run("UPDATE deviations SET title = 'Synthetic revised' WHERE id = ?", deviation);
    const stale = await request(sidecarPath, { cookie: cookies.viewer });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'EVIDENCE_EXPORT_CHANGED');
    await db.run(`INSERT INTO member_module_access (id, site_id, user_id, module, allowed, created_at, updated_at)
      VALUES (?, ?, ?, 'deviations', FALSE, ?, ?)`, randomUUID(), site.id, users.viewer.id, at, at);
    assert.equal((await request(listing, { cookie: cookies.viewer })).status, 403);
    await assert.rejects(() => getAttachment(db, attached.body.id, users.viewer, storage), { status: 403 });
    assert.equal((await request(exportPath, { cookie: cookies.viewer })).status, 403);
  });
}

test('synthetic evidence seed presents comparable and incomparable exports and a waiver, and resets cleanly', async t => {
  const db = await wbsDatabase(t, 'sqlite');
  await db.transaction(seedDemo);
  const site = await db.get("SELECT id FROM sites WHERE code = 'FITT-01'");
  const all = await listDeviations(db, { siteId: site.id });
  assert.equal(all.filter(row => row.absence === true).length, 2);
  assert.equal(all.find(row => row.source_id === 'FITT-EV-3').absence_reason, 'different_scope');
  assert.equal(all.filter(row => row.internal_owner_id != null).length, 2);
  assert.ok(all.some(row => row.source_system === 'internal' && row.traceability === 'none' && row.internal_owner_id == null));
  assert.equal((await listTasks(db, { siteId: site.id, closedWithWaiver: true })).length, 1);
  await db.transaction(seedDemo);
  assert.deepEqual(await listDeviations(db, { siteId: site.id }), all);
  await db.transaction(resetDemo);
  assert.deepEqual(await db.all('SELECT * FROM deviation_exports'), []);
  assert.deepEqual(await db.all('SELECT * FROM deviation_export_rows'), []);
});

async function streamBytes(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
