import { createHash, randomUUID } from 'node:crypto';
import { requireModule } from './module-access.mjs';
import { fail, instant, invalid, requireUser, text, uuid, validateInput } from './place-asset-scope.mjs';
import { requireRole } from './repository.mjs';

const managers = ['owner', 'editor'];
const readers = [...managers, 'verifier', 'viewer'];
const ownerOnly = ['owner'];
const exerciseRoles = {
  executor: managers,
  inspector: managers,
  verifier: ['owner', 'verifier'],
};
const registers = {
  people: { givenName: 'given_name', familyName: 'family_name', language: 'language' },
  companies: {},
  teams: { leadCompanyId: 'lead_company_id' },
};
const relations = {
  affiliations: {
    refs: { personId: 'people', companyId: 'companies' },
    key: ['person_id', 'company_id', 'relationship'],
  },
  'company-roles': { refs: { companyId: 'companies' }, key: ['company_id', 'role'] },
  'team-memberships': { refs: { teamId: 'teams', personId: 'people' }, key: ['team_id', 'person_id', 'role'] },
  'authority-roles': { refs: { personId: 'people' }, key: ['person_id', 'role'], expires: true },
  'authority-delegations': { refs: {}, key: ['authority_role_id', 'recipient_link_id'], expires: true },
};
const dependencies = {
  people: [['affiliations', 'person_id'], ['team-memberships', 'person_id'], ['authority-roles', 'person_id'],
    ['account-links', 'person_id']],
  companies: [['affiliations', 'company_id'], ['company-roles', 'company_id'], ['teams', 'lead_company_id']],
  teams: [['team-memberships', 'team_id']],
};
const filters = {
  affiliations: { personId: 'person_id', companyId: 'company_id' },
  'company-roles': { companyId: 'company_id' },
  'team-memberships': { personId: 'person_id', teamId: 'team_id' },
  'account-links': { personId: 'person_id', accountId: 'account_id' },
  'authority-roles': { personId: 'person_id' },
  'authority-delegations': { authorityRoleId: 'authority_role_id' },
  'authority-snapshots': { authorityRoleId: 'authority_role_id' },
};
const table = collection => `registry_${collection.replaceAll('-', '_')}`;
const missing = () => fail(404, 'REGISTRY_NOT_FOUND', 'Registry record not found on this site.');
const conflict = (code, message) => fail(409, code, message);
const snake = name => name.replace(/[A-Z]/g, character => '_' + character.toLowerCase());
const iso = value => value instanceof Date ? value.toISOString() : value;
const normalizeLabel = value => value.normalize('NFKC').toLowerCase();

function publicRecord(row) {
  const { search_name, evidence, ...record } = row;
  return evidence === undefined ? record : { ...record, evidence: JSON.parse(evidence) };
}

async function authorize(db, site, user, roles) {
  const role = await requireRole(db, site, user, roles);
  await requireModule(db, site, user, 'registry');
  return role;
}

async function recordById(db, site, collection, id, active = false) {
  const row = await db.get(`SELECT * FROM ${table(collection)} WHERE site_id = ? AND id = ?`, site, id);
  if (!row) missing();
  if (active && row.archived_at) conflict('REGISTRY_ARCHIVED', 'The referenced record is archived.');
  return row;
}

// These are relationships with a present or future nonempty interval.
async function activeDependencies(db, site, collection, id, at) {
  const result = [];
  for (const [target, column] of dependencies[collection]) {
    const criteria = target === 'teams' ? 'archived_at IS NULL' : target === 'account-links' ? 'revoked_at IS NULL'
      : 'revoked_at IS NULL AND (valid_to IS NULL OR valid_to > ?)';
    const params = ['teams', 'account-links'].includes(target) ? [] : [at];
    const rows = await db.all(`SELECT id FROM ${table(target)} WHERE site_id = ? AND ${column} = ?
      AND ${criteria} ORDER BY id`, site, id, ...params);
    if (rows.length) result.push({ collection: target, ids: rows.map(row => row.id) });
  }
  return result;
}

export async function readRegistry(db, scope, options, user) {
  requireUser(user);
  const { collection } = scope;
  const site = uuid(scope.siteId, 'siteId');
  const accountLinks = collection === 'account-links';
  const role = await authorize(db, site, user, accountLinks ? ownerOnly : readers);
  const master = Object.hasOwn(registers, collection);
  if (scope.id) {
    const id = uuid(scope.id, 'id');
    const record = publicRecord(await recordById(db, site, collection, id));
    if (scope.action === 'history') {
      const events = await db.all(`SELECT revision, action, recorded_at, actor_id, reason, before_state, after_state
        FROM registry_history WHERE site_id = ? AND collection = ? AND record_id = ?
        ORDER BY revision DESC LIMIT ? OFFSET ?`, site, collection, id, options.limit, options.offset);
      return events.map(({ before_state, after_state, ...event }) => ({
        ...event, before: JSON.parse(before_state), after: JSON.parse(after_state),
      }));
    }
    if (!master) return record;
    const related = await activeDependencies(db, site, collection, id, new Date().toISOString());
    return { ...record, canArchive: managers.includes(role) && !record.archived_at && !related.length,
      dependencies: related.filter(dep => role === 'owner' || dep.collection !== 'account-links') };
  }

  const clauses = ['site_id = ?'], params = [site];
  if (master) {
    if (!options.includeArchived) clauses.push('archived_at IS NULL');
    if (options.q) {
      clauses.push("search_name LIKE ? ESCAPE '!'");
      const query = normalizeLabel(text(options.q, 'q')).replace(/[!%_]/g, match => '!' + match);
      params.push('%' + query + '%');
    }
  } else {
    for (const [field, column] of Object.entries(filters[collection])) {
      const value = options.searchParams.get(field);
      if (value !== null) {
        clauses.push(column + ' = ?');
        params.push(uuid(value, field));
      }
    }
  }
  const order = master ? 'search_name, id' : collection === 'authority-snapshots' ? 'recorded_at DESC, id' : 'valid_from DESC, id';
  const rows = await db.all(`SELECT * FROM ${table(collection)} WHERE ${clauses.join(' AND ')}
    ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, options.limit, options.offset);
  return rows.map(publicRecord);
}

async function insert(tx, collection, fields) {
  const columns = Object.keys(fields);
  return await tx.get(`INSERT INTO ${table(collection)} (${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')}) RETURNING *`, ...Object.values(fields));
}

async function changed(tx, collection, before, fields) {
  return await tx.get(`UPDATE ${table(collection)} SET ${Object.keys(fields).map(key => key + ' = ?').join(', ')},
    revision = revision + 1 WHERE site_id = ? AND id = ? RETURNING *`,
  ...Object.values(fields), before.site_id, before.id);
}

async function history({ tx, site, at, user }, collection, action, reason, after, before = null) {
  await tx.run(`INSERT INTO registry_history (site_id, collection, record_id, revision, action, recorded_at, actor_id,
    reason, before_state, after_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  site, collection, after.id, after.revision, action, at, user.id, reason,
  before && JSON.stringify(publicRecord(before)), JSON.stringify(publicRecord(after)));
  return publicRecord(after);
}

function checkRevision(row, expected) {
  if (!Number.isSafeInteger(expected) || expected < 1) invalid('revision must be a positive integer.');
  if (row.revision !== expected) conflict('REGISTRY_REVISION_CONFLICT', 'The record has changed.');
}

function choice(value, field, choices) {
  if (!choices.includes(value)) invalid('Invalid ' + field + '.');
  return value;
}

async function writeMaster(ctx, collection, id, action, input) {
  const { tx, site, at, user } = ctx;
  const optional = registers[collection];
  const reason = text(input.reason, 'reason', { max: 2000 });
  const before = id ? await recordById(tx, site, collection, id, true) : null;
  if (before) checkRevision(before, input.revision);
  if (action === 'archive') {
    validateInput(input, ['revision', 'reason']);
    if ((await activeDependencies(tx, site, collection, id, at)).length) {
      conflict('REGISTRY_ACTIVE_REFERENCES', 'Close or reassign current and scheduled references before archiving.');
    }
    return await history(ctx, collection, action, reason, await changed(tx, collection, before, { archived_at: at }), before);
  }
  validateInput(input, ['name', ...Object.keys(optional), 'reason', ...(before ? ['revision'] : [])]);
  const fields = {};
  if (!before || Object.hasOwn(input, 'name')) {
    fields.name = text(input.name, 'name');
    fields.search_name = normalizeLabel(fields.name);
  }
  for (const [field, column] of Object.entries(optional)) {
    if (!Object.hasOwn(input, field)) continue;
    if (field === 'leadCompanyId' && input[field] != null) {
      fields[column] = (await recordById(tx, site, 'companies', uuid(input[field], field), true)).id;
    } else if (field === 'language' && input[field] != null) {
      fields[column] = choice(input[field], field, ['it', 'en']);
    } else {
      fields[column] = text(input[field], field, { optional: true });
    }
  }
  if (!before) {
    const after = await insert(tx, collection, { id: randomUUID(), site_id: site, created_at: at, created_by: user.id, ...fields });
    return await history(ctx, collection, action, reason, after);
  }
  if (Object.entries(fields).every(([key, value]) => before[key] === value)) return publicRecord(before);
  return await history(ctx, collection, action, reason, await changed(tx, collection, before, fields), before);
}

// Used inside an authorized reconciliation transaction holding the site lock.
export async function createReconciledCompany(ctx, input) {
  return await writeMaster(ctx, 'companies', null, 'create', input);
}

function interval(input, expires, { at, from = at } = {}) {
  const start = input.validFrom === undefined ? from : instant(input.validFrom, 'validFrom');
  const end = input.validTo == null && !expires ? null : instant(input.validTo, 'validTo');
  if (end && end <= start) invalid('validTo must be after validFrom.');
  return { valid_from: start, valid_to: end };
}

function active(row, at) {
  return iso(row.valid_from) <= at && (!row.valid_to || at < iso(row.valid_to))
    && (!row.revoked_at || at < iso(row.revoked_at));
}

async function preventOverlap({ tx, site }, collection, fields, key) {
  const checks = ['site_id = ?', ...key.map(column => column + ' = ?'),
    '(valid_to IS NULL OR valid_to > ?)', '(revoked_at IS NULL OR (revoked_at > ? AND revoked_at > valid_from))'];
  const params = [site, ...key.map(column => fields[column]), fields.valid_from, fields.valid_from];
  if (fields.valid_to) {
    checks.push('valid_from < ?');
    params.push(fields.valid_to);
  }
  if (await tx.get(`SELECT 1 FROM ${table(collection)} WHERE ${checks.join(' AND ')} LIMIT 1`, ...params)) {
    conflict('REGISTRY_INTERVAL_OVERLAP', 'A matching relationship overlaps this interval.');
  }
}

async function createRelation(ctx, collection, input, { leadChange = false } = {}) {
  const { tx, site, at, user } = ctx;
  const relation = relations[collection];
  const reason = text(input.reason, 'reason', { max: 2000 });
  const fields = interval(input, relation.expires, { at });
  for (const [field, target] of Object.entries(relation.refs)) {
    fields[snake(field)] = (await recordById(tx, site, target, uuid(input[field], field), true)).id;
  }
  let extra = [];
  switch (collection) {
    case 'affiliations':
      extra = ['relationship', 'source'];
      for (const field of extra) fields[field] = text(input[field], field);
      break;
    case 'company-roles':
      extra = ['role'];
      fields.role = choice(input.role, 'role', ['contractor', 'subcontractor', 'inspection_body', 'supplier']);
      break;
    case 'team-memberships':
      extra = ['role'];
      fields.role = choice(input.role, 'role', ['member', 'lead']);
      break;
    case 'authority-roles':
      extra = ['role'];
      fields.role = choice(input.role, 'role', Object.keys(exerciseRoles));
      break;
    case 'authority-delegations':
      extra = ['authorityRoleId', 'recipientPersonId'];
      Object.assign(fields, await delegationFields(ctx, input, fields));
      break;
  }
  validateInput(input, [...Object.keys(relation.refs), ...extra, 'validFrom', 'validTo', 'reason']);
  const key = fields.role === 'lead' ? ['team_id', 'role'] : relation.key;
  await preventOverlap(ctx, collection, fields, key);
  const after = await insert(tx, collection, { id: randomUUID(), site_id: site, created_at: at, created_by: user.id, ...fields });
  return await history(ctx, collection, leadChange ? 'replace-lead' : 'create', reason, after);
}

async function replaceLead(ctx, teamId, input) {
  validateInput(input, ['previousId', 'revision', 'personId', 'validFrom', 'validTo', 'reason']);
  const { tx, site } = ctx;
  const reason = text(input.reason, 'reason', { max: 2000 });
  await recordById(tx, site, 'teams', teamId, true);
  const previous = await recordById(tx, site, 'team-memberships', uuid(input.previousId, 'previousId'));
  checkRevision(previous, input.revision);
  const from = instant(input.validFrom, 'validFrom');
  if (previous.team_id !== teamId || previous.role !== 'lead' || previous.revoked_at || from <= iso(previous.valid_from)
      || (previous.valid_to && from > iso(previous.valid_to))) {
    conflict('REGISTRY_LEAD_INTERVAL', 'The new mandate must start within or at the end of the previous mandate.');
  }
  if (from !== iso(previous.valid_to)) {
    await history(ctx, 'team-memberships', 'close', reason,
      await changed(tx, 'team-memberships', previous, { valid_to: from }), previous);
  }
  return await createRelation(ctx, 'team-memberships', {
    teamId, personId: input.personId, role: 'lead', validFrom: from, validTo: input.validTo, reason,
  }, { leadChange: true });
}

async function revokeRelation(ctx, collection, id, input) {
  validateInput(input, ['reason', 'revision']);
  const { tx, site, at } = ctx;
  const reason = text(input.reason, 'reason', { max: 2000 });
  const before = await recordById(tx, site, collection, id);
  checkRevision(before, input.revision);
  if (before.revoked_at) return publicRecord(before);
  return await history(ctx, collection, 'revoke', reason,
    await changed(tx, collection, before, { revoked_at: at }), before);
}

async function closeRelation(ctx, collection, id, input) {
  validateInput(input, ['reason', 'revision', 'validTo']);
  const { tx, site } = ctx;
  const reason = text(input.reason, 'reason', { max: 2000 });
  const end = instant(input.validTo, 'validTo');
  const before = await recordById(tx, site, collection, id);
  checkRevision(before, input.revision);
  if (before.revoked_at || end <= iso(before.valid_from) || (before.valid_to && end > iso(before.valid_to))) {
    conflict('REGISTRY_CLOSE_INTERVAL', 'The end must shorten an existing interval without cancelling it.');
  }
  if (end === iso(before.valid_to)) return publicRecord(before);
  return await history(ctx, collection, 'close', reason, await changed(tx, collection, before, { valid_to: end }), before);
}

async function member(db, site, account) {
  return await db.get(`SELECT m.role FROM accessible_site_members m JOIN users u ON u.id = m.user_id
    WHERE m.site_id = ? AND u.id = ? AND u.disabled_at IS NULL`, site, account);
}

async function createAccountLink(ctx, input) {
  validateInput(input, ['personId', 'accountId', 'reason']);
  const { tx, site, at, user } = ctx;
  const reason = text(input.reason, 'reason', { max: 2000 });
  const person = await recordById(tx, site, 'people', uuid(input.personId, 'personId'), true);
  const account = uuid(input.accountId, 'accountId');
  const membership = await member(tx, site, account);
  if (!readers.includes(membership?.role)) missing();
  if (await tx.get(`SELECT 1 FROM registry_account_links WHERE site_id = ? AND revoked_at IS NULL
    AND (person_id = ? OR account_id = ?)`, site, person.id, account)) {
    conflict('REGISTRY_ACCOUNT_LINK_CONFLICT', 'This person or account already has an active link on the site.');
  }
  const after = await insert(tx, 'account-links', { id: randomUUID(), site_id: site, person_id: person.id,
    account_id: account, valid_from: at, created_at: at, created_by: user.id });
  return await history(ctx, 'account-links', 'create', reason, after);
}

const authorityDenied = () => fail(403, 'REGISTRY_AUTHORITY_REQUIRED', 'Active internal operational authority is required.');

async function actingLink({ tx, site, at }, link, role) {
  if (!link || !active(link, at)) authorityDenied();
  const person = await recordById(tx, site, 'people', link.person_id);
  const membership = await member(tx, site, link.account_id);
  if (person.archived_at || !exerciseRoles[role]?.includes(membership?.role)) authorityDenied();
  await requireModule(tx, site, { id: link.account_id }, 'registry');
  return { personId: person.id, label: person.name, accountLinkId: link.id, applicationRole: membership.role };
}

async function delegationFields(ctx, input, fields) {
  const { tx, site, at } = ctx;
  const grant = await recordById(tx, site, 'authority-roles', uuid(input.authorityRoleId, 'authorityRoleId'));
  if (!active(grant, at)) authorityDenied();
  if (fields.valid_from < iso(grant.valid_from) || fields.valid_to > iso(grant.valid_to)) {
    invalid('The delegation interval must be within the authority role interval.');
  }
  const grantor = await tx.get(`SELECT * FROM registry_account_links WHERE site_id = ? AND person_id = ?
    AND revoked_at IS NULL`, site, grant.person_id);
  const recipientPerson = await recordById(tx, site, 'people', uuid(input.recipientPersonId, 'recipientPersonId'), true);
  const recipient = await tx.get(`SELECT * FROM registry_account_links WHERE site_id = ? AND person_id = ?
    AND revoked_at IS NULL`, site, recipientPerson.id);
  await actingLink(ctx, grantor, grant.role);
  await actingLink(ctx, recipient, grant.role);
  if (recipient.id === grantor.id) invalid('A delegation requires two different people.');
  if (fields.valid_from < iso(grantor.valid_from) || fields.valid_from < iso(recipient.valid_from)) {
    invalid('The delegation cannot start before its account links.');
  }
  return { authority_role_id: grant.id, grantor_link_id: grantor.id, recipient_link_id: recipient.id };
}

async function authorityEvidence(ctx, input) {
  validateInput(input, ['authorityRoleId', 'delegationId']);
  const { tx, site, at, user } = ctx;
  const grant = await recordById(tx, site, 'authority-roles', uuid(input.authorityRoleId, 'authorityRoleId'));
  if (!active(grant, at)) authorityDenied();
  const link = await tx.get(`SELECT * FROM registry_account_links WHERE site_id = ? AND account_id = ?
    AND revoked_at IS NULL`, site, user.id);
  const actor = await actingLink(ctx, link, grant.role);
  let holder = actor, delegation = null;
  if (input.delegationId != null) {
    delegation = await recordById(tx, site, 'authority-delegations', uuid(input.delegationId, 'delegationId'));
    if (!active(delegation, at) || delegation.authority_role_id !== grant.id ||
        delegation.recipient_link_id !== link.id) authorityDenied();
    holder = await actingLink(ctx, await recordById(tx, site, 'account-links', delegation.grantor_link_id), grant.role);
  }
  if (holder.personId !== grant.person_id) authorityDenied();
  return {
    authority_role_id: grant.id, delegation_id: delegation?.id ?? null, account_link_id: link.id,
    evidence: JSON.stringify({ role: grant.role, authorityRevision: grant.revision, validFrom: iso(grant.valid_from),
      validTo: iso(grant.valid_to), holder, actor, delegation: delegation && { revision: delegation.revision,
        validFrom: iso(delegation.valid_from), validTo: iso(delegation.valid_to) } }),
  };
}

export async function writeRegistry(db, scope, input, user, { key, requestHash } = {}) {
  requireUser(user);
  const { collection, action } = scope;
  const site = uuid(scope.siteId, 'siteId');
  const id = scope.id ? uuid(scope.id, 'id') : null;
  const snapshot = collection === 'authority-snapshots';
  const roles = snapshot ? [...managers, 'verifier'] : collection === 'account-links' ? ownerOnly : managers;
  const route = `registry/${site}/${collection}/${id ?? ''}/${action}`;
  const receipt = key === undefined ? null : 'registry:' + createHash('sha256')
    .update(JSON.stringify([site, user.id, uuid(key, 'Idempotency-Key')])).digest('hex');
  return await db.transaction(async tx => {
    await authorize(tx, site, user, roles);
    // Share the site write lock with membership changes, and serialize interval checks with the subsequent insert.
    await tx.run('UPDATE sites SET id = id WHERE id = ?', site);
    await authorize(tx, site, user, roles);
    const at = new Date().toISOString();
    const ctx = { tx, site, at, user };
    // A retry cannot confer authority on a caller whose grant was subsequently revoked.
    const evidence = snapshot ? await authorityEvidence(ctx, input) : null;
    if (receipt) {
      const prior = await tx.get('SELECT route, request_hash, body FROM idempotency_keys WHERE key = ?', receipt);
      if (prior) {
        if (prior.route !== route || prior.request_hash !== requestHash) {
          conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used for another request.');
        }
        return JSON.parse(prior.body);
      }
    }
    let result;
    if (snapshot) {
      result = publicRecord(await insert(tx, collection, { id: randomUUID(), site_id: site, recorded_at: at, actor_id: user.id, ...evidence }));
    } else if (action === 'replace-lead') {
      result = await replaceLead(ctx, id, input);
    } else if (Object.hasOwn(registers, collection)) {
      result = await writeMaster(ctx, collection, id, action, input);
    } else if (action === 'revoke') {
      result = await revokeRelation(ctx, collection, id, input);
    } else if (action === 'close') {
      result = await closeRelation(ctx, collection, id, input);
    } else if (collection === 'account-links') {
      result = await createAccountLink(ctx, input);
    } else {
      result = await createRelation(ctx, collection, input);
    }
    if (receipt) {
      await tx.run(`INSERT INTO idempotency_keys (key, route, request_hash, status, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`, receipt, route, requestHash, ['create', 'replace-lead'].includes(action) ? 201 : 200,
      JSON.stringify(result), at);
    }
    return result;
  });
}
