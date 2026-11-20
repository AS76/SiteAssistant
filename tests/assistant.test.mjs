import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSite } from '../server/repository.mjs';
import { chat, allowRequest, MAX_PER_WINDOW } from '../server/assistant.mjs';
import { authFixture } from './helpers/auth.mjs';
import { openSqliteTestDb } from './helpers/db.mjs';

const reply = (message) => ({ ok: true, json: async () => ({ model: 'fake', choices: [{ message }], usage: { total_tokens: 10 } }) });

async function fixture() {
  const database = await openSqliteTestDb();
  const db = database.db;
  const auth = await authFixture(db);
  const site = await createSite(db, { code: randomUUID(), name: 'Synthetic assistant site' });
  for (const role of ['owner', 'viewer']) await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, auth.users[role].id, role);
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
    { apiKey: undefined, fetchImpl: async () => reply({ content: 'x' }) }), { status: 503, code: 'ASSISTANT_NOT_CONFIGURED' });
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
