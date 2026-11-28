import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createServer } from '../server/http.mjs';
import { createSite } from '../server/repository.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { wbsDatabase } from './helpers/wbs.mjs';

const now = '2030-02-01T10:00:00.000Z';
const past = '2030-02-01T09:00:00.000Z';
const cutoff = '2030-02-01T11:00:00.000Z';
const later = '2030-02-01T12:00:00.000Z';

function checked(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  if (code) assert.equal(response.body.code, code);
  return response.body;
}

for (const driver of ['sqlite', 'pg']) test(`site registry (${driver})`, async t => {
  const db = await wbsDatabase(t, driver);
  t.mock.timers.enable({ apis: ['Date'], now: new Date(now) });
  const site = await createSite(db, { code: 'EXAMPLE-A', name: 'Example site A' });
  const other = await createSite(db, { code: 'EXAMPLE-B', name: 'Example site B' });
  const { users, cookies } = await authFixture(db, site);
  await db.run("INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, 'owner')", other.id, users.owner.id);
  const request = requestListener(createServer(db, { authBypassUser: users.owner.email, production: false }));
  const send = (path, { method = 'GET', body, role = 'owner', siteId = site.id, key } = {}) =>
    request(`/api/sites/${siteId}/${path}`, { method, body, cookie: cookies[role],
      headers: key ? { 'idempotency-key': key } : {} });
  const create = async (path, body, options) =>
    checked(await send(path, { ...options, method: 'POST', body: { reason: 'Synthetic example', ...body } }), 201);
  const revoke = async (path, row) =>
    checked(await send(`${path}/${row.id}/revoke`, { method: 'POST', body: { revision: row.revision, reason: 'Synthetic revocation' } }), 200);

  let person, company, team, recipient, holderLink, grant, delegated, snapshot;
  const usersBefore = await db.all('SELECT id FROM users ORDER BY id');
  const membershipsBefore = await db.all('SELECT * FROM site_members ORDER BY site_id, user_id');

  await t.test('creates account-free records, paginates label search and enforces role and module permissions', async () => {
    const key = randomUUID();
    const body = { name: 'Example È 100%', givenName: 'Example', language: 'it' };
    person = await create('people', body, { role: 'editor', key });
    assert.equal((await create('people', body, { role: 'editor', key })).id, person.id);
    checked(await send('people', { role: 'editor', key, method: 'POST', body: { name: 'Other example', reason: 'Synthetic' } }),
      409, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(person.revision, 1);
    assert.equal(person.created_by, users.editor.id);
    assert.ok(!Object.hasOwn(person, 'search_name'));
    recipient = await create('people', { name: 'Example recipient', language: 'en' });
    company = await create('companies', { name: 'Example Company' });
    team = await create('teams', { name: 'Example Crew', leadCompanyId: company.id }, { role: 'editor' });
    assert.equal(team.lead_company_id, company.id);
    assert.deepEqual(await db.all('SELECT id FROM users ORDER BY id'), usersBefore);
    assert.deepEqual(await db.all('SELECT * FROM site_members ORDER BY site_id, user_id'), membershipsBefore);
    assert.deepEqual(await db.all('SELECT * FROM registry_account_links'), []);

    const response = await send('people?q=%C3%A8%20100%25&limit=1', { role: 'viewer' });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(checked(response, 200).map(row => row.id), [person.id]);
    assert.equal(checked(await send('people?limit=1&offset=1', { role: 'verifier' }), 200).length, 1);
    for (const role of ['viewer', 'verifier']) {
      checked(await send('companies', { role, method: 'POST', body: { name: 'Denied company', reason: 'Synthetic' } }), 403, 'FORBIDDEN');
    }
    checked(await send('people', { role: 'guest' }), 401);
    checked(await send('people', { role: 'viewer', siteId: other.id }), 403, 'FORBIDDEN');

    for (const [path, sensitive] of [['people', { email: 'synthetic@example.invalid' }], ['companies', { taxId: 'SYNTHETIC' }],
      ['people', { employeeId: randomUUID() }]]) {
      checked(await send(path, { method: 'POST', body: { name: 'Example', reason: 'Synthetic', ...sensitive } }),
        400, 'VALIDATION_ERROR');
    }
    const access = allowed => request('/api/member-access', { method: 'PUT', cookie: cookies.owner,
      body: { site_id: site.id, member_id: users.viewer.id, module: 'registry', allowed } });
    checked(await access(false), 200);
    checked(await send('people', { role: 'viewer' }), 403, 'MODULE_FORBIDDEN');
    checked(await access(true), 200);
    assert.equal(checked(await send('people', { role: 'viewer' }), 200).length, 2);
  });

  await t.test('scopes all references to the site and serializes overlapping affiliations', async () => {
    const foreignCompany = await create('companies', { name: 'Other site company' }, { siteId: other.id });
    checked(await send(`companies/${foreignCompany.id}`), 404, 'REGISTRY_NOT_FOUND');
    checked(await send('teams', { method: 'POST', body: { name: 'Cross-site crew', reason: 'Synthetic', leadCompanyId: foreignCompany.id } }),
      404, 'REGISTRY_NOT_FOUND');
    await assert.rejects(db.run('UPDATE registry_teams SET lead_company_id = ? WHERE id = ?', foreignCompany.id, team.id),
      /foreign key/i);
    const affiliation = { personId: person.id, companyId: company.id, relationship: 'contracted', source: 'manual',
      validFrom: past, validTo: cutoff, reason: 'Synthetic example' };
    const write = () => send('affiliations', { method: 'POST', body: affiliation, role: 'editor' });
    const results = (await Promise.all([write(), write()])).sort((a, b) => a.status - b.status);
    checked(results[0], 201);
    checked(results[1], 409, 'REGISTRY_INTERVAL_OVERLAP');
    const second = await create('affiliations', { ...affiliation, relationship: 'liaison' });
    assert.notEqual(second.id, results[0].body.id);
    assert.equal(checked(await send(`affiliations?personId=${person.id}`, { role: 'viewer' }), 200).length, 2);
    const closed = checked(await send(`affiliations/${second.id}/close`, { method: 'POST', body: {
      validTo: now, revision: second.revision, reason: 'Synthetic end',
    } }), 200);
    assert.equal(closed.valid_to, now);
    const history = checked(await send(`affiliations/${second.id}/history`), 200);
    assert.equal(history[0].before.valid_to, cutoff);
    const supply = await create('company-roles', { companyId: company.id, role: 'supplier', validFrom: past, validTo: cutoff });
    assert.equal(supply.role, 'supplier');
  });

  await t.test('records crew membership and replaces a lead atomically at a half-open boundary', async () => {
    const member = await create('team-memberships', { teamId: team.id, personId: recipient.id, role: 'member', validFrom: past, validTo: later });
    assert.equal(member.valid_to, later);
    const lead = await create('team-memberships', { teamId: team.id, personId: person.id, role: 'lead', validFrom: past });
    const replacement = { previousId: lead.id, revision: lead.revision, personId: recipient.id, validFrom: cutoff, validTo: later };
    checked(await send('team-memberships', { method: 'POST', body: { teamId: team.id, personId: recipient.id,
      role: 'lead', validFrom: cutoff, reason: 'Synthetic attempt' } }), 409, 'REGISTRY_INTERVAL_OVERLAP');
    checked(await send(`teams/${team.id}/replace-lead`, { method: 'POST', body: { ...replacement,
      personId: randomUUID(), reason: 'Synthetic attempt' } }), 404, 'REGISTRY_NOT_FOUND');
    assert.equal(checked(await send(`team-memberships/${lead.id}`), 200).valid_to, null);

    const newLead = await create(`teams/${team.id}/replace-lead`, replacement, { role: 'editor' });
    const old = checked(await send(`team-memberships/${lead.id}`, { role: 'viewer' }), 200);
    assert.equal(old.valid_to, newLead.valid_from);
    const leads = checked(await send(`team-memberships?teamId=${team.id}`), 200).filter(row => row.role === 'lead');
    const leaderAt = at => leads.filter(row => row.valid_from <= at && (row.valid_to === null || at < row.valid_to))
      .map(row => row.person_id);
    assert.deepEqual(leaderAt(now), [person.id]);
    assert.deepEqual(leaderAt(cutoff), [recipient.id]);
    const history = checked(await send(`team-memberships/${lead.id}/history`), 200);
    assert.equal(history[0].before.valid_to, null);
    assert.equal(history[1].after.valid_to, null);
    checked(await send(`teams/${team.id}/replace-lead`, { method: 'POST', body: { ...replacement,
      reason: 'Stale revision' } }), 409, 'REGISTRY_REVISION_CONFLICT');
  });

  await t.test('requires an explicit owner-confirmed link and active internal authority', async () => {
    const link = { personId: person.id, accountId: users.editor.id };
    checked(await send('account-links', { method: 'POST', role: 'editor', body: { ...link, reason: 'Synthetic attempt' } }),
      403, 'FORBIDDEN');
    checked(await send('account-links', { method: 'POST', body: { ...link, accountId: randomUUID(), reason: 'Synthetic attempt' } }),
      404, 'REGISTRY_NOT_FOUND');
    holderLink = await create('account-links', link);
    await create('account-links', { personId: recipient.id, accountId: users.owner.id });
    checked(await send('account-links', { role: 'viewer' }), 403, 'FORBIDDEN');
    checked(await send('account-links', { method: 'POST', body: { ...link, reason: 'Duplicate link' } }), 409, 'REGISTRY_ACCOUNT_LINK_CONFLICT');

    grant = await create('authority-roles', { personId: person.id, role: 'executor', validFrom: past, validTo: later }, { role: 'editor' });
    const delegation = { authorityRoleId: grant.id, recipientPersonId: recipient.id, validTo: cutoff };
    checked(await send('authority-delegations', { method: 'POST', body: { ...delegation, validTo: '2030-02-01T13:00:00.000Z',
      reason: 'Exceeds mandate' } }), 400, 'VALIDATION_ERROR');
    delegated = await create('authority-delegations', delegation, { role: 'editor' });
    assert.equal(delegated.valid_to, cutoff);

    const evidence = (body, role, key) => send('authority-snapshots', { method: 'POST', body, role, key });
    const direct = checked(await evidence({ authorityRoleId: grant.id }, 'editor'), 201);
    assert.equal(direct.evidence.holder.personId, person.id);
    assert.equal(direct.evidence.delegation, null);
    checked(await evidence({ authorityRoleId: grant.id }, 'owner'), 403, 'REGISTRY_AUTHORITY_REQUIRED');
    checked(await evidence({ authorityRoleId: grant.id }, 'verifier'), 403, 'REGISTRY_AUTHORITY_REQUIRED');
    checked(await evidence({ authorityRoleId: grant.id }, 'viewer'), 403, 'FORBIDDEN');
    const requestBody = { authorityRoleId: grant.id, delegationId: delegated.id };
    const key = randomUUID();
    snapshot = checked(await evidence(requestBody, 'owner', key), 201);
    assert.equal(snapshot.actor_id, users.owner.id);
    assert.equal(snapshot.evidence.holder.label, person.name);
    assert.equal(snapshot.evidence.actor.personId, recipient.id);
    assert.deepEqual(checked(await evidence(requestBody, 'owner', key), 201), snapshot);

    await revoke('authority-delegations', delegated);
    checked(await evidence(requestBody, 'owner', key), 403, 'REGISTRY_AUTHORITY_REQUIRED');
    assert.deepEqual(checked(await send(`authority-snapshots/${snapshot.id}`, { role: 'viewer' }), 200), snapshot);
    const history = checked(await send(`authority-delegations/${delegated.id}/history`), 200);
    assert.equal(history[0].before.revoked_at, null);
    assert.equal(history[0].after.revoked_at, now);
    assert.equal(history[1].after.revoked_at, null);
    assert.equal(history[1].after.valid_to, cutoff);
    assert.equal(history[0].actor_id, users.owner.id);
    checked(await send(`authority-snapshots/${snapshot.id}`, { method: 'PATCH', body: {} }), 404);
    assert.deepEqual(await db.all('SELECT id FROM users ORDER BY id'), usersBefore);
    assert.deepEqual(await db.all('SELECT * FROM site_members ORDER BY site_id, user_id'), membershipsBefore);
  });

  await t.test('expiry is exclusive, revoking the parent role also revokes its effective delegation, and snapshots stay fixed', async () => {
    const expiring = await create('authority-roles', { personId: person.id, role: 'inspector', validTo: cutoff });
    const activeDelegation = await create('authority-delegations', { authorityRoleId: grant.id,
      recipientPersonId: recipient.id, validTo: cutoff });
    const evidence = (body, role) => send('authority-snapshots', { method: 'POST', body, role });
    t.mock.timers.setTime(Date.parse(cutoff) - 1);
    checked(await evidence({ authorityRoleId: expiring.id }, 'editor'), 201);
    checked(await evidence({ authorityRoleId: grant.id, delegationId: activeDelegation.id }, 'owner'), 201);
    t.mock.timers.setTime(Date.parse(cutoff));
    checked(await evidence({ authorityRoleId: expiring.id }, 'editor'), 403, 'REGISTRY_AUTHORITY_REQUIRED');
    checked(await evidence({ authorityRoleId: grant.id, delegationId: activeDelegation.id }, 'owner'), 403, 'REGISTRY_AUTHORITY_REQUIRED');

    const current = await create('authority-delegations', { authorityRoleId: grant.id, recipientPersonId: recipient.id, validTo: later });
    checked(await evidence({ authorityRoleId: grant.id, delegationId: current.id }, 'owner'), 201);
    await revoke('authority-roles', grant);
    checked(await evidence({ authorityRoleId: grant.id }, 'editor'), 403, 'REGISTRY_AUTHORITY_REQUIRED');
    checked(await evidence({ authorityRoleId: grant.id, delegationId: current.id }, 'owner'), 403, 'REGISTRY_AUTHORITY_REQUIRED');

    const update = checked(await send(`people/${person.id}`, { method: 'PATCH', role: 'editor', body: {
      name: 'Updated example', revision: person.revision, reason: 'Synthetic update',
    } }), 200);
    assert.equal(update.revision, person.revision + 1);
    assert.deepEqual(checked(await send(`authority-snapshots/${snapshot.id}`), 200), snapshot);
    person = update;
  });

  await t.test('archive blocks current and planned references, and keeps old cards and snapshots queryable', async () => {
    const archive = (path, row) => send(`${path}/${row.id}/archive`, { method: 'POST', role: 'editor',
      body: { revision: row.revision, reason: 'Synthetic archival' } });
    checked(await archive('people', person), 409, 'REGISTRY_ACTIVE_REFERENCES');
    checked(await archive('teams', team), 409, 'REGISTRY_ACTIVE_REFERENCES');
    checked(await archive('companies', company), 409, 'REGISTRY_ACTIVE_REFERENCES');

    const planned = await create('people', { name: 'Planned member' });
    const future = await create('team-memberships', { teamId: team.id, personId: planned.id, role: 'member', validFrom: later });
    checked(await archive('people', planned), 409, 'REGISTRY_ACTIVE_REFERENCES');
    await revoke('team-memberships', future);
    checked(await archive('people', planned), 200);

    await revoke('account-links', holderLink);
    checked(await archive('people', person), 200);
    assert.ok(!checked(await send('people'), 200).some(row => row.id === person.id));
    assert.ok(checked(await send('people?includeArchived=1'), 200).some(row => row.id === person.id && row.archived_at));
    assert.ok(checked(await send(`people/${person.id}`, { role: 'verifier' }), 200).archived_at);
    checked(await send('team-memberships', { method: 'POST', body: { teamId: team.id, personId: person.id, role: 'member',
      reason: 'Archived person' } }), 409, 'REGISTRY_ARCHIVED');
    t.mock.timers.setTime(Date.parse(later));
    checked(await archive('teams', team), 200);
    checked(await archive('companies', company), 200);
    assert.deepEqual(checked(await send(`authority-snapshots/${snapshot.id}`, { role: 'viewer' }), 200), snapshot);
  });
});
