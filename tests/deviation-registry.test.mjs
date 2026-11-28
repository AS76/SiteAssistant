import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { storeDeviationExport } from '../server/deviations.mjs';
import { createServer } from '../server/http.mjs';
import { saveModuleAccess } from '../server/module-access.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { openSqliteTestDb } from './helpers/db.mjs';
import { deviationsDatabase, deviationsSource } from './helpers/deviations.mjs';
import { decisionItem, link, occurrence, request, siteFixture } from './helpers/task-reconciliation.mjs';

const attribution = (causingCompany, resolvingCompany, attributionState = 'agreed') =>
  ({ causingCompany, resolvingCompany, attributionState });
const unresolved = { action: 'unresolved', reason: 'Synthetic evidence is insufficient' };

function checked(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  if (code) assert.equal(response.body.code, code);
  return response.body;
}

async function setup(t, db) {
  if (!db) {
    const fixture = await openSqliteTestDb();
    db = fixture.db;
    t.after(fixture.close);
  }
  const { users, cookies } = await authFixture(db);
  const f = await siteFixture(db, users);
  const api = requestListener(createServer(db));
  const site = f.site.id;
  const send = (path, body, role = 'editor', siteId = site) => api(`/api/sites/${siteId}/people-reconciliation/deviations${path}`,
    { method: body == null ? 'GET' : 'POST', body, cookie: cookies[role] });
  const detail = (id, role = 'viewer', include = '?include=registry_history') =>
    api(`/api/deviations/${id}${include}`, { cookie: cookies[role] });
  const editAttribution = async (id, body) => checked(await api(`/api/deviations/${id}/attribution`,
    { method: 'PATCH', body, cookie: cookies.editor }), 200);
  const importRow = async (row, date = '2026-01-01', siteId = site) => {
    const meta = { sourceSystem: 'other', exportDate: date, scope: 'Synthetic scope',
      fileSha256: randomBytes(32).toString('hex'), complete: true };
    await db.transaction(tx => storeDeviationExport(tx, siteId, meta, [row], date + 'T09:00:00.000Z'));
    return (await db.get('SELECT id FROM deviations WHERE site_id = ? AND source_id = ?', siteId, row.source_id)).id;
  };
  const preview = async (recordId, fields, role = 'editor') =>
    checked(await send('/previews', { occurrences: fields.map(field => occurrence(recordId, field)) }, role), 200);
  const activate = async () => checked(await send('/adoption', {}, 'owner'), 200);
  const apply = async (body, role = 'editor') => checked(await send(`/batches/${body.batchId}/apply`, {}, role), 200);
  const approve = async (items, decisions) => {
    const body = request(...items.map(item => decisionItem(item, decisions[item.field])));
    checked(await send('/batches', body), 200);
    return body;
  };
  return { db, f, users, cookies, api, site, send, detail, editAttribution, importRow, preview, activate, apply, approve };
}

test('Deviations apply approved typed links once, preserving source text, attribution and audit', async t => {
  const r = await setup(t);
  const { db, f, users, site } = r;
  const author = await f.person('Synthetic author');
  const team = await f.team('Synthetic crew');
  const cause = await f.company('Synthetic cause');
  const resolver = await f.company('Synthetic resolver');
  const row = { source_id: randomUUID(), title: 'Synthetic deviation', status: 'open',
    author: '  Synthetic author  ', assigned_to: team.name };
  const id = await r.importRow(row);
  await r.editAttribution(id, attribution(cause.name, resolver.name, 'not_determined'));
  const existing = await db.get('SELECT * FROM deviations WHERE id = ?', id);
  const permissionTables = ['users', 'site_members', 'registry_account_links', 'registry_team_memberships', 'registry_authority_roles'];
  const countPermissions = () => Promise.all(permissionTables.map(table => db.get(`SELECT COUNT(*) AS count FROM ${table}`)));
  const permissions = await countPermissions();
  const fields = ['author', 'assigned_to', 'causing_company', 'resolving_company'];
  const { items, adoption, counts } = await r.preview(id, fields, 'verifier');
  assert.equal(adoption.enabled, false);
  assert.equal(counts.unresolved, 4);
  const source = items.find(item => item.field === 'author').source;
  assert.equal(source.original, row.author);
  assert.equal(source.provenance.kind, 'import');
  assert.equal(source.provenance.identityState, 'resolved');
  assert.deepEqual([source.provenance.sourceSystem, source.provenance.exportDate], ['other', '2026-01-01']);
  assert.equal(items.find(item => item.field === 'causing_company').source.provenance.attributionState, 'not_determined');

  await r.activate();
  const decisions = { author: link('person', author), assigned_to: link('team', team),
    causing_company: link('company', cause), resolving_company: link('company', resolver) };
  const batch = await r.approve(items, decisions);
  assert.equal(checked(await r.send('/batches', batch), 200).status, 'decided');
  assert.equal((await db.all('SELECT id FROM deviations')).length, 1);
  assert.equal((await db.all('SELECT version FROM deviation_registry_links')).length, 0);
  checked(await r.send(`/batches/${batch.batchId}/apply`, {}, 'verifier'), 403, 'FORBIDDEN');
  const applied = await r.apply(batch, 'owner');
  assert.equal(applied.counts.applied, 4);
  assert.deepEqual(await r.apply(batch), applied);
  assert.deepEqual(await db.get('SELECT * FROM deviations WHERE id = ?', id), existing);
  assert.deepEqual(await countPermissions(), permissions);

  // Simulate the receipt written by 679404b for a tracked export without a planning key.
  const legacySnapshot = JSON.stringify({ ...source, provenance: { ...source.provenance, identityState: null } });
  await db.run('UPDATE reconciliation_items SET source_snapshot = ?, source_revision = ? WHERE batch_id = ? AND field = ?',
    legacySnapshot, createHash('sha256').update(legacySnapshot).digest('hex'), batch.batchId, 'author');
  const retry = await r.approve((await r.preview(id, ['author'])).items, decisions);
  assert.equal((await r.apply(retry)).items[0].status, 'matched');
  const snapshot = checked(await r.detail(id), 200).registry_history;
  assert.ok(snapshot.every(entry => entry.current));
  assert.deepEqual(snapshot.find(entry => entry.field === 'author').snapshot,
    { id: author.id, name: author.name, revision: author.revision, kind: 'person' });
  assert.equal(snapshot.find(entry => entry.field === 'author').original_label, row.author);
  assert.equal(checked(await r.detail(id, 'viewer', ''), 200).registry_history, undefined);
  const receipt = checked(await r.send(`/batches/${batch.batchId}`, undefined, 'viewer'), 200);
  assert.equal(receipt.decidedBy, users.editor.id);
  assert.equal(receipt.appliedBy, users.owner.id);
  assert.ok(checked(await r.send(`/batches?recordId=${id}`, undefined, 'verifier'), 200).some(item => item.id === batch.batchId));
  const events = checked(await r.api(`/api/deviations/${id}/events`, { cookie: r.cookies.viewer }), 200)
    .filter(event => event.action === 'registry_link');
  assert.equal(events.length, 4);
  assert.ok(events.every(event => event.actor_id === users.owner.id && event.source === 'internal' && event.note === null));
  const audit = await db.all("SELECT actor, changes FROM audit_events WHERE site_id = ? AND entity_id = ?", site, id);
  assert.equal(audit.filter(event => event.actor === users.owner.id && JSON.parse(event.changes).note?.action === 'registry_link').length, 4);

  const renamed = await f.registry('people', { revision: author.revision, name: 'Synthetic renamed author' }, 'update', author.id);
  await f.registry('people', { revision: renamed.revision }, 'archive', author.id);
  assert.equal(checked(await r.send('/candidates?field=author&q=Synthetic', undefined, 'viewer'), 200).total, 0);
  const archived = checked(await r.detail(id), 200).registry_history.find(entry => entry.field === 'author');
  assert.ok(archived.archived_at);
  assert.equal(archived.current, false);
  assert.equal(archived.snapshot.name, author.name);
  const archivedPreview = await r.preview(id, ['author']);
  checked(await r.send('/batches', request(decisionItem(archivedPreview.items[0], link('person', renamed)))),
    404, 'DEVIATION_REGISTRY_TARGET_NOT_FOUND');

  await saveModuleAccess(db, { siteId: site, memberId: users.viewer.id, module: 'registry', allowed: false }, users.owner);
  assert.equal(checked(await r.detail(id), 200).registry_history, undefined);
  checked(await r.send('/candidates?field=author&q=Synthetic', undefined, 'viewer'), 403, 'MODULE_FORBIDDEN');
  checked(await r.send(`/batches/${batch.batchId}`, undefined, 'viewer'), 403, 'MODULE_FORBIDDEN');
});

test('Legacy ingestion without export metadata can link only a resolved author identity on SQLite', async t => {
  const db = await deviationsDatabase(t, 'sqlite');
  const r = await setup(t, db);
  const author = await r.f.person('Synthetic author');
  await deviationsSource(db, r.f.site, ['manual', 'unresolved'].map(identity_state => ({
    title: 'Synthetic legacy deviation', author: author.name, source_status: 'open', identity_state,
  })));
  const imported = checked(await r.api('/api/deviations/import', {
    method: 'POST', body: { site_id: r.site }, cookie: r.cookies.owner,
  }), 200);
  assert.equal(imported.imported, 2);
  const [unresolvedRow, resolvedRow] = await db.all(`SELECT id, source_system, source_id, source_export_date, source_entity_key_id
    FROM deviations WHERE site_id = ? ORDER BY source_entity_key_id IS NOT NULL`, r.site);
  assert.deepEqual([unresolvedRow.source_system, unresolvedRow.source_id, unresolvedRow.source_export_date,
    unresolvedRow.source_entity_key_id], [null, null, null, null]);
  assert.ok(resolvedRow.source_entity_key_id);
  assert.deepEqual(await db.all('SELECT target_id FROM planning_import_keys WHERE site_id = ?', r.site), []);

  await r.activate();
  const [blocked] = (await r.preview(unresolvedRow.id, ['author'])).items;
  assert.equal(blocked.source.original, author.name);
  assert.equal(blocked.source.provenance.identityState, 'unresolved');
  assert.equal(blocked.source.linkable, false);
  const rejected = request(decisionItem(blocked, link('person', author)));
  checked(await r.send('/batches', rejected), 409, 'DEVIATION_REGISTRY_UNRESOLVED');
  assert.deepEqual(await db.all('SELECT id FROM reconciliation_batches WHERE id = ?', rejected.batchId), []);

  const [eligible] = (await r.preview(resolvedRow.id, ['author'])).items;
  assert.equal(eligible.source.provenance.identityState, 'resolved');
  assert.equal(eligible.source.linkable, true);
  const applied = await r.apply(await r.approve([eligible], { author: link('person', author) }));
  assert.equal(applied.items[0].status, 'applied');
  const links = await db.all('SELECT deviation_id FROM deviation_registry_links WHERE site_id = ?', r.site);
  assert.deepEqual(links.map(row => row.deviation_id), [resolvedRow.id]);
});

test('Ambiguous labels, wrong roles and cross-site choices cannot create deviation links', async t => {
  const r = await setup(t);
  const author = await r.f.person('Synthetic homonym');
  await r.f.person(author.name);
  const company = await r.f.company('Synthetic cause');
  const other = await siteFixture(r.db, { owner: r.users.owner });
  const foreign = await other.person(author.name);
  const row = { source_id: randomUUID(), title: 'Synthetic deviation', status: 'open', author: author.name };
  const id = await r.importRow(row);
  const foreignId = await r.importRow({ ...row, source_id: randomUUID() }, '2026-01-01', other.site.id);
  const [item] = (await r.preview(id, ['author'])).items;
  assert.equal(item.status, 'unresolved');
  assert.equal(item.candidates.total, 2);
  assert.ok(!item.candidates.records.some(candidate => candidate.id === foreign.id));
  checked(await r.send('/previews', { occurrences: [occurrence(foreignId, 'author')] }), 404, 'RECONCILIATION_SOURCE_NOT_FOUND');
  checked(await r.send('/candidates?field=author', undefined, 'viewer', other.site.id), 403, 'FORBIDDEN');
  checked(await r.send('/adoption', {}), 403, 'FORBIDDEN');
  await r.activate();

  const missingIdentity = request(decisionItem(item, { action: 'link', kind: 'person', reason: 'Same label only' }));
  checked(await r.send('/batches', missingIdentity), 400, 'VALIDATION_ERROR');
  checked(await r.send('/batches', request(decisionItem(item, link('person', foreign)))), 404, 'DEVIATION_REGISTRY_TARGET_NOT_FOUND');
  checked(await r.send('/batches', request(decisionItem(item, link('company', company)))), 400, 'VALIDATION_ERROR');
  checked(await r.send('/batches', request(decisionItem(item, unresolved)), 'viewer'), 403, 'FORBIDDEN');
  assert.equal((await r.apply(await r.approve([item], { author: unresolved }))).items[0].status, 'unresolved');

  await r.editAttribution(id, attribution(company.name, null, 'disputed'));
  const [disputed] = (await r.preview(id, ['causing_company'])).items;
  checked(await r.send('/batches', request(decisionItem(disputed, link('company', company)))), 409, 'DEVIATION_REGISTRY_UNRESOLVED');

  const pending = await r.approve([item], { author: link('person', author) });
  assert.equal(await r.importRow({ ...row, author: 'Synthetic revised author' }), id);
  assert.equal(await r.importRow(row), id);
  const [restored] = (await r.preview(id, ['author'])).items;
  assert.equal(restored.source.original, item.source.original);
  assert.equal(restored.source.provenance.revision, 2);
  assert.equal((await r.apply(pending)).items[0].status, 'stale');
  checked(await r.send('/batches', request(decisionItem(item, link('person', author)))), 409, 'RECONCILIATION_STALE');
  const run = randomUUID(), at = '2026-01-01T10:00:00Z';
  await r.db.run(`INSERT INTO planning_import_runs (id, site_id, family, created_by, created_at)
    VALUES (?, ?, 'deviations', ?, ?)`, run, r.site, r.users.owner.id, at);
  await r.db.run(`INSERT INTO planning_import_keys
    (site_id, family, import_key, target_id, identity_state, last_import_run_id, created_at, updated_at)
    VALUES (?, 'deviations', 'synthetic-key', ?, 'unresolved', ?, ?, ?)`, r.site, id, run, at, at);
  const [unresolvedImport] = (await r.preview(id, ['author'])).items;
  assert.equal(unresolvedImport.source.linkable, false);
  checked(await r.send('/batches', request(decisionItem(unresolvedImport, link('person', author)))),
    409, 'DEVIATION_REGISTRY_UNRESOLVED');
  assert.equal(checked(await r.detail(id), 200).attribution_state, 'disputed');
  assert.deepEqual(await r.db.all('SELECT version FROM deviation_registry_links'), []);
});

test('Deviation rollback compensates its own intervals and preserves manual changes', async t => {
  const r = await setup(t);
  const author = await r.f.person('Synthetic author');
  const corrected = await r.f.person('Synthetic corrected author');
  const company = await r.f.company('Synthetic cause');
  const row = { source_id: randomUUID(), title: 'Synthetic deviation', status: 'closed', author: author.name };
  const id = await r.importRow(row);
  await r.editAttribution(id, attribution(company.name, null));
  await r.activate();
  const first = await r.approve((await r.preview(id, ['author', 'causing_company'])).items,
    { author: link('person', author), causing_company: link('company', company) });
  assert.equal((await r.apply(first)).counts.applied, 2);
  await r.editAttribution(id, attribution('Manual company correction', 'Manual resolver', 'disputed'));
  const beforeRollback = checked(await r.detail(id), 200);
  assert.equal(beforeRollback.registry_history.find(entry => entry.field === 'causing_company').current, false);

  const second = await r.approve((await r.preview(id, ['author'])).items, { author: link('person', corrected) });
  assert.equal((await r.apply(second)).counts.applied, 1);
  const path = `/batches/${first.batchId}/rollback`, reason = { reason: 'Synthetic rollback' };
  checked(await r.send(path, reason), 403, 'FORBIDDEN');
  const rolledBack = checked(await r.send(path, reason, 'owner'), 200);
  assert.deepEqual(rolledBack.counts, { compensated: 1, conflicting: 1 });
  assert.equal(rolledBack.adoption.enabled, false);
  assert.deepEqual(checked(await r.send(path, reason, 'owner'), 200), rolledBack);
  assert.equal(rolledBack.items.find(item => item.field === 'author').code, 'DEVIATION_REGISTRY_SUPERSEDED');
  const after = checked(await r.detail(id), 200);
  assert.deepEqual([after.author, after.status, after.causing_company, after.resolving_company, after.attribution_state],
    [row.author, 'closed', 'Manual company correction', 'Manual resolver', 'disputed']);
  assert.equal(after.registry_history.find(entry => entry.batch_id === second.batchId).valid_to, null);
  assert.equal(after.registry_history.find(entry => entry.field === 'causing_company').end_action, 'compensated');
  await r.activate();
  assert.equal(checked(await r.detail(id), 200).registry_history.find(entry => entry.current).snapshot.id, corrected.id);
  const events = await r.db.all('SELECT action FROM deviation_events WHERE deviation_id = ? ORDER BY id', id);
  assert.deepEqual(events.map(event => event.action),
    ['attribution', 'registry_link', 'registry_link', 'attribution', 'registry_link', 'registry_rollback']);
});
