import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSite, updateSiteAssistant } from '../server/repository.mjs';
import { chat, allowRequest, MAX_PER_WINDOW, providerPolicy } from '../server/assistant.mjs';
import { authFixture } from './helpers/auth.mjs';
import { openSqliteTestDb } from './helpers/db.mjs';

const reply = (message) => ({ ok: true, json: async () => ({ model: 'fake', choices: [{ message }], usage: { total_tokens: 10 } }) });

async function fixture() {
  const database = await openSqliteTestDb();
  const db = database.db;
  const auth = await authFixture(db);
  const site = await createSite(db, { code: randomUUID(), name: 'Synthetic assistant site' });
  for (const role of ['owner', 'viewer']) await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, auth.users[role].id, role);
  await updateSiteAssistant(db, site.id, { enabled: true }, auth.users.owner);
  await db.run(`INSERT INTO deviations (id, site_id, deviation_no, title, status, created_at)
    VALUES (?, ?, 'DEV-777', 'Synthetic open deviation', 'open', '2026-11-01T08:00:00.000Z')`, randomUUID(), site.id);
  return { db, auth, site, close: database.close };
}

test('assistant: a tool call is executed against the site and its rows become citations', async t => {
  const { db, auth, site, close } = await fixture();
  t.after(close);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) {
      return reply({ role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function',
        function: { name: 'find_records', arguments: JSON.stringify({ family: 'deviations', status: 'open' }) } }] });
    }
    return reply({ role: 'assistant', content: 'Risulta aperta una deviazione [DEV-777].' });
  };
  const result = await chat(db, { siteId: site.id, user: auth.users.viewer, messages: [{ role: 'user', content: 'Ci sono deviazioni aperte?' }], view: 'deviations' },
    { fetchImpl, apiKey: 'test-key' });
  assert.match(result.reply, /DEV-777/);
  assert.deepEqual(result.citations.map(citation => citation.label), ['DEV-777']);
  assert.equal(calls[1].messages.at(-1).role, 'tool');
  assert.match(calls[1].messages.at(-1).content, /DEV-777/);
});

test('assistant: without a key the endpoint refuses instead of failing open', async t => {
  const { db, auth, site, close } = await fixture();
  t.after(close);
  await assert.rejects(() => chat(db, { siteId: site.id, user: auth.users.viewer, messages: [{ role: 'user', content: 'ciao' }] },
    { apiKey: '', fetchImpl: async () => reply({ content: 'x' }) }), { status: 503, code: 'ASSISTANT_NOT_CONFIGURED' });
});

test('assistant: provider routing policy is sent only when explicitly configured', async t => {
  const { db, auth, site, close } = await fixture();
  t.after(close);
  const bodies = [];
  const fetchImpl = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return reply({ role: 'assistant', content: 'OK' });
  };
  await chat(db, { siteId: site.id, user: auth.users.viewer, messages: [{ role: 'user', content: 'x' }] },
    { fetchImpl, apiKey: 'test-key', provider: { zdr: true, data_collection: 'deny', allow_fallbacks: false, only: ['together'] } });
  assert.deepEqual(bodies[0].provider, { zdr: true, data_collection: 'deny', allow_fallbacks: false, only: ['together'] });
  await chat(db, { siteId: site.id, user: auth.users.viewer, messages: [{ role: 'user', content: 'x' }] },
    { fetchImpl, apiKey: 'test-key', provider: null });
  assert.equal(bodies[1].provider, undefined);
});

test('assistant: malformed provider routing policy fails closed', async t => {
  const { db, auth, site, close } = await fixture();
  t.after(close);
  await assert.rejects(() => chat(db, { siteId: site.id, user: auth.users.viewer, messages: [{ role: 'user', content: 'x' }] },
    { apiKey: 'test-key', fetchImpl: async () => reply({ content: 'x' }), provider: { invalid: true } }),
  { status: 503, code: 'ASSISTANT_NOT_CONFIGURED' });
});

test('assistant: provider policy rejects unknown keys and invalid types', async t => {
  const { db, auth, site, close } = await fixture();
  t.after(close);
  for (const provider of [{ headers: { authorization: 'x' } }, { zdr: 'yes' }, { data_collection: 'sometimes' }, { only: 'together' }]) {
    await assert.rejects(() => chat(db, { siteId: site.id, user: auth.users.viewer, messages: [{ role: 'user', content: 'x' }] },
      { apiKey: 'test-key', fetchImpl: async () => reply({ content: 'x' }), provider }),
    { status: 503, code: 'ASSISTANT_NOT_CONFIGURED' });
  }
});

test('assistant: environment policy validation rejects reserved or malformed shapes', () => {
  assert.deepEqual(providerPolicy('{"zdr":true,"data_collection":"deny","only":["together"],"allow_fallbacks":false}'),
    { zdr: true, data_collection: 'deny', only: ['together'], allow_fallbacks: false });
  assert.deepEqual(providerPolicy('{"messages":[]}'), { invalid: true });
  assert.deepEqual(providerPolicy('{"zdr":"true"}'), { invalid: true });
  assert.deepEqual(providerPolicy('{"only":"together"}'), { invalid: true });
  assert.deepEqual(providerPolicy('[]'), { invalid: true });
  assert.deepEqual(providerPolicy('not-json'), { invalid: true });
  assert.equal(providerPolicy(''), null);
});

test('assistant: a tool error is returned to the model, not thrown at the user', async t => {
  const { db, auth, site, close } = await fixture();
  t.after(close);
  let second;
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (!second) {
      second = true;
      return reply({ role: 'assistant', content: '', tool_calls: [{ id: 'call_x', type: 'function',
        function: { name: 'find_records', arguments: JSON.stringify({ family: 'unknown_family' }) } }] });
    }
    return reply({ role: 'assistant', content: 'Non ho dati su quella famiglia.' });
  };
  const result = await chat(db, { siteId: site.id, user: auth.users.viewer, messages: [{ role: 'user', content: 'x' }] },
    { fetchImpl, apiKey: 'test-key' });
  assert.match(result.reply, /Non ho dati/);
});

test('assistant: the per-user window stops runaway loops', () => {
  const user = randomUUID();
  for (let index = 0; index < MAX_PER_WINDOW; index++) assert.equal(allowRequest(user), true);
  assert.equal(allowRequest(user), false);
  assert.equal(allowRequest(randomUUID()), true);
});
