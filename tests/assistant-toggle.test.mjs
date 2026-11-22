import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createServer } from '../server/http.mjs';
import { applyMigration } from '../server/migrations/index.mjs';
import { createSite } from '../server/repository.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { wbsDatabase } from './helpers/wbs.mjs';

const message = [{ role: 'user', content: 'Show tasks for this site.' }];
const reply = message => ({ ok: true, json: async () => ({ choices: [{ message }] }) });
const toolCall = (name, args) => ({ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const settings = ({ assistant_enabled, assistant_timeout_ms }) => [assistant_enabled, assistant_timeout_ms];
function assertError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.body.code, code);
}

for (const [driver, engine] of [['sqlite', 'SQLite'], ['pg', 'PGlite']]) {
  test(`assistant settings and chat on ${engine}`, async t => {
    const db = await wbsDatabase(t, driver, { beforeOperational: true });
    for (const file of ['036_wbs_operational.sql', '037_wbs_source_scope_backfill.sql', '038_identity_evidence.sql',
      '040_site_time_zone.sql', '045_diary_versions.sql']) {
      await db.transaction(tx => applyMigration(tx, file, { driver }));
    }
    const siteA = await createSite(db, { code: 'SYN-A', name: 'Synthetic site A' });
    const { users, cookies } = await authFixture(db, siteA);
    await db.transaction(tx => applyMigration(tx, '047_site_assistant.sql', { driver }));

    let provider = async () => reply({ content: 'Synthetic response.' });
    const fetchImpl = t.mock.fn((url, options) => provider(options));
    const request = requestListener(createServer(db, { assistant: { apiKey: 'test-key', baseUrl: 'https://provider.example.invalid', fetchImpl } }));
    const get = (id, role = 'owner') => request(`/api/sites/${id}`, { cookie: cookies[role] });
    const patch = (id, body, role = 'owner') => request(`/api/sites/${id}/assistant`, { method: 'PATCH', cookie: cookies[role], body });
    const chat = (id, role = 'viewer', messages = message) => request('/api/assistant/chat', {
      method: 'POST', cookie: cookies[role], body: { site_id: id, language: 'en', messages },
    });
    const audit = async () => {
      const response = await request(`/api/audit-events?site_id=${siteA.id}&entity_type=site`, { cookie: cookies.owner });
      assert.equal(response.status, 200);
      return response.body;
    };
    const created = await request('/api/sites', { method: 'POST', cookie: cookies.owner, body: { code: 'SYN-B', name: 'Synthetic site B' } });
    assert.equal(created.status, 201);
    const siteB = created.body;

    await t.test('existing and new sites default to off and chat rejects before calling the provider', async () => {
      assert.deepEqual(settings(created.body), [false, 20000]);
      for (const [site, role] of [[siteA, 'viewer'], [siteB, 'owner']]) {
        const response = await get(site.id, role);
        assert.equal(response.status, 200);
        assert.deepEqual(settings(response.body), [false, 20000]);
        assertError(await chat(site.id, role, []), 409, 'ASSISTANT_DISABLED');
      }
      assert.equal(fetchImpl.mock.callCount(), 0);
      assertError(await get(siteB.id, 'editor'), 403, 'FORBIDDEN');
      assertError(await chat(siteB.id, 'editor'), 403, 'FORBIDDEN');
      await assert.rejects(() => db.run('UPDATE sites SET assistant_timeout_ms = 1000 WHERE id = ?', siteA.id), /check/i);
      await assert.rejects(() => db.run('UPDATE sites SET assistant_enabled = NULL WHERE id = ?', siteA.id), /not[- ]null/i);
    });

    await t.test('only owners can change settings and the API validates the payload', async () => {
      for (const role of ['editor', 'verifier', 'viewer']) {
        assertError(await patch(siteA.id, { enabled: true }, role), 403, 'FORBIDDEN');
      }
      for (const body of [{}, { enabled: 1 }, { enabled: true, timeout_ms: 1000 }, { enabled: true, timeout_ms: 60001 },
        { enabled: true, timeout_ms: 5000.5 }, { enabled: true, timeout_ms: '20000' }, { enabled: true, timeout_ms: null }]) {
        assertError(await patch(siteA.id, body), 400, 'VALIDATION_ERROR');
      }
      assert.deepEqual(settings((await get(siteA.id)).body), [false, 20000]);
      assert.deepEqual(await audit(), []);
    });

    await t.test('an owner enables one site, chat works and the change is audited once', async () => {
      const enabled = await patch(siteA.id, { enabled: true, timeout_ms: 20000 });
      assert.equal(enabled.status, 200);
      assert.deepEqual(settings(enabled.body), [true, 20000]);
      assert.equal((await patch(siteA.id, { enabled: true })).status, 200);
      const events = await audit();
      assert.equal(events.length, 1);
      const [event] = events;
      assert.equal(event.actor, users.owner.id);
      assert.equal(event.entity_id, siteA.id);
      assert.equal(event.action, 'update');
      assert.deepEqual(typeof event.changes === 'string' ? JSON.parse(event.changes) : event.changes,
        { assistant_enabled: { from: false, to: true } });
      const response = await chat(siteA.id);
      assert.equal(response.status, 200);
      assert.equal(response.body.reply, 'Synthetic response.');
      assert.deepEqual(settings((await get(siteB.id)).body), [false, 20000]);
      assertError(await chat(siteB.id, 'owner'), 409, 'ASSISTANT_DISABLED');
      assert.equal(fetchImpl.mock.callCount(), 1);
    });

    await t.test('tools use the requested site and reject a proposed write', async () => {
      const taskA = randomUUID(), taskB = randomUUID();
      for (const [task, site, title] of [[taskA, siteA, 'Synthetic task A'], [taskB, siteB, 'Synthetic task B']]) {
        await db.run(`INSERT INTO tasks (id, site_id, title, executor, verifier, created_at)
          VALUES (?, ?, ?, 'Synthetic executor', 'Synthetic verifier', ?)`, task, site.id, title, new Date().toISOString());
      }
      const before = await db.all('SELECT * FROM tasks ORDER BY id');
      let results;
      provider = async ({ body }) => {
        const input = JSON.parse(body);
        assert.deepEqual(input.tools.map(tool => tool.function.name), ['find_records', 'count_records', 'sum_hours']);
        const toolResults = input.messages.filter(entry => entry.role === 'tool');
        if (!toolResults.length) return reply({ tool_calls: [
          toolCall('find_records', { family: 'tasks', site_id: siteB.id }),
          toolCall('update_task', { family: 'tasks', id: taskA, status: 'closed' }),
        ] });
        results = toolResults.map(entry => JSON.parse(entry.content));
        return reply({ content: 'Synthetic task found.' });
      };
      const response = await chat(siteA.id, 'owner');
      assert.equal(response.status, 200);
      assert.deepEqual(results[0].rows.map(row => row.id), [taskA]);
      assert.equal(results[1].error, 'UNKNOWN_TOOL');
      assert.deepEqual(response.body.citations.map(cite => cite.id), [taskA]);
      assert.deepEqual(await db.all('SELECT * FROM tasks ORDER BY id'), before);
    });

    await t.test('the configured deadline spans tool rounds and aborts a stalled provider body', { timeout: 10000 }, async subtest => {
      assert.deepEqual(settings((await patch(siteA.id, { enabled: true, timeout_ms: 5000 })).body), [true, 5000]);
      subtest.mock.timers.enable({ apis: ['setTimeout'] });
      const firstRound = Promise.withResolvers(), firstReply = Promise.withResolvers(), readingBody = Promise.withResolvers();
      provider = ({ signal, body }) => {
        const messages = JSON.parse(body).messages;
        if (!messages.some(entry => entry.role === 'tool')) {
          firstRound.resolve(signal);
          return firstReply.promise;
        }
        return { ok: true, json: () => {
          readingBody.resolve(signal);
          return new Promise(() => {});
        } };
      };
      const pending = chat(siteA.id);
      const signal = await firstRound.promise;
      subtest.mock.timers.tick(3000);
      firstReply.resolve(reply({ tool_calls: [toolCall('count_records', { family: 'tasks' })] }));
      assert.equal(await readingBody.promise, signal);
      subtest.mock.timers.tick(1999);
      assert.equal(signal.aborted, false);
      subtest.mock.timers.tick(1);
      assert.equal(signal.aborted, true);
      assertError(await pending, 504, 'ASSISTANT_TIMEOUT');
    });

    await t.test('provider errors keep their codes and disabling preserves the chosen timeout', async () => {
      for (const [providerStatus, status, code] of [[401, 503, 'ASSISTANT_AUTH'], [429, 429, 'ASSISTANT_RATE_LIMITED'], [500, 502, 'ASSISTANT_UNAVAILABLE']]) {
        provider = async () => ({ ok: false, status: providerStatus });
        assertError(await chat(siteA.id), status, code);
      }
      provider = async () => { throw new TypeError('Synthetic network failure'); };
      assertError(await chat(siteA.id), 502, 'ASSISTANT_UNAVAILABLE');
      const disabled = await patch(siteA.id, { enabled: false });
      assert.equal(disabled.status, 200);
      assert.deepEqual(settings(disabled.body), [false, 5000]);
      assertError(await chat(siteA.id), 409, 'ASSISTANT_DISABLED');
      const changes = (await audit()).map(event => typeof event.changes === 'string' ? JSON.parse(event.changes) : event.changes);
      assert.equal(changes.length, 3);
      assert.ok(changes.some(change => change.assistant_timeout_ms?.from === 20000 && change.assistant_timeout_ms.to === 5000));
      assert.ok(changes.some(change => change.assistant_enabled?.from === true && change.assistant_enabled.to === false));
    });
  });
}
