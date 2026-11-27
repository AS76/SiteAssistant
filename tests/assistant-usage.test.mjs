import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { messages } from '../app/i18n.mjs';
import { assistantPrices, assistantUsageStatus } from '../server/assistant-usage.mjs';
import { createLoginLimiter, login } from '../server/auth.mjs';
import { createServer } from '../server/http.mjs';
import { createSite, updateSiteAssistant } from '../server/repository.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { wbsDatabase } from './helpers/wbs.mjs';

const tokens = (prompt_tokens, completion_tokens) => ({ prompt_tokens, completion_tokens });
const reply = (usage, { model = 'synthetic-metered', tools = false } = {}) => ({
  ok: true, json: async () => ({ model, usage, choices: [{ message: tools ? {
    tool_calls: [{ id: 'count', type: 'function', function: { name: 'count_records', arguments: '{"family":"tasks"}' } }],
  } : { content: 'Synthetic response.' } }] }),
});

test('assistant usage thresholds apply to the exact stored amount', () => {
  for (const [cost, state] of [[0, 'normal'], [9_999_999_999, 'normal'], [10_000_000_000, 'warning'],
    [17_999_999_999, 'warning'], [18_000_000_000, 'critical'], [24_999_999_999, 'critical'], [25_000_000_000, 'blocked']]) {
    assert.equal(assistantUsageStatus(cost), state);
  }
});

test('assistant prices have defaults and allow validated per-model overrides', () => {
  const defaults = assistantPrices('{}');
  assert.ok(defaults.get('deepseek-flash').input > 0);
  const prices = assistantPrices('{"deepseek-flash":{"input":0,"output":0.01},"synthetic-model":{"input":1e-9,"output":0.02}}');
  assert.deepEqual(prices.get('deepseek-flash'), { input: 0, output: 0.01 });
  assert.deepEqual(prices.get('synthetic-model'), { input: 1e-9, output: 0.02 });
  assert.deepEqual(prices.get('deepseek-v4-pro'), defaults.get('deepseek-v4-pro'));
  for (const invalid of ['{', '[]', '{"x":{"input":0}}', '{"x":{"input":0,"output":-1}}',
    '{"x":{"input":1e-10,"output":0}}', '{"x":{"input":"0","output":0}}']) {
    assert.throws(() => assistantPrices(invalid), { code: 'ASSISTANT_NOT_CONFIGURED' });
  }
});

test('assistant usage UI texts have matching Italian and English keys and placeholders', () => {
  const usageKeys = language => Object.keys(language).filter(key => key.startsWith('aiUsage') || key === 'aiErrorBudget').sort();
  assert.deepEqual(usageKeys(messages.it), usageKeys(messages.en));
  for (const key of usageKeys(messages.it)) {
    assert.deepEqual(messages.it[key].match(/\{\w+\}/g), messages.en[key].match(/\{\w+\}/g), key);
  }
});

for (const [driver, engine] of [['sqlite', 'SQLite'], ['pg', 'PGlite']]) {
  test(`assistant usage and budget on ${engine}`, async t => {
    const db = await wbsDatabase(t, driver);
    const now = '2026-11-01T00:00:00.000Z';
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
    const priceEnv = 'ASSISTANT_PRICES_USD_PER_TOKEN';
    const originalPrices = process.env[priceEnv];
    process.env[priceEnv] = '{"synthetic-metered":{"input":0.1,"output":0.2}}';
    t.after(() => {
      if (originalPrices === undefined) delete process.env[priceEnv];
      else process.env[priceEnv] = originalPrices;
    });

    const site = await createSite(db, { code: 'SYN-AI-A', name: 'Synthetic assistant A' }, { demoSandbox: true });
    const other = await createSite(db, { code: 'SYN-AI-B', name: 'Synthetic assistant B' });
    const { users, cookies } = await authFixture(db, site);
    await db.run("INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, 'owner')", other.id, users.verifier.id);
    await updateSiteAssistant(db, site.id, { enabled: true }, users.owner);
    await updateSiteAssistant(db, other.id, { enabled: true }, users.verifier);
    await db.run(`INSERT INTO assistant_usage
      (id, site_id, user_id, requested_at, model, input_tokens, output_tokens, cost_nanousd)
      VALUES (?, ?, ?, ?, 'synthetic-metered', 400, 0, 40000000000)`,
    randomUUID(), site.id, users.owner.id, '2026-10-31T23:59:59.999Z');

    let provider;
    const fetchImpl = t.mock.fn((_, { body }) => provider(JSON.parse(body)));
    const request = requestListener(createServer(db, { assistant: { apiKey: 'test-key', model: 'synthetic-requested', fetchImpl } }));
    const usage = (id = site.id, role = 'owner') => request(`/api/assistant/usage?site_id=${id}`, { cookie: cookies[role] });
    const chat = (id = site.id, role = 'viewer') => request('/api/assistant/chat', {
      method: 'POST', cookie: cookies[role], body: { site_id: id, language: 'en',
        messages: [{ role: 'user', content: 'Show the synthetic tasks.' }] },
    });
    const rows = () => db.all(`SELECT user_id, site_id, requested_at, model, input_tokens, output_tokens, cost_nanousd, reason
      FROM assistant_usage WHERE site_id = ? AND requested_at >= ?`, site.id, now);
    const summary = async (expected, id, role) => {
      const response = await usage(id, role);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        month: '2026-11', thresholds_usd: { warning: 10, critical: 18, blocked: 25 }, ...expected,
      });
    };

    await t.test('the owner alone can read the current site summary', async () => {
      await summary({ estimated_cost_usd: 0, requests: 0, unpriced_requests: 0, status: 'normal' });
      for (const role of ['editor', 'verifier', 'viewer']) assert.equal((await usage(site.id, role)).status, 403);
      assert.equal((await usage(site.id, 'anonymous')).status, 401);
      assert.equal((await usage(other.id)).status, 403);
      assert.equal((await usage('invalid')).status, 400);
      await db.run('UPDATE users SET demo_sandbox = TRUE WHERE id = ?', users.editor.id);
      await db.run("UPDATE site_members SET role = 'demo_user' WHERE site_id = ? AND user_id = ?", site.id, users.editor.id);
      assert.equal((await usage(site.id, 'editor')).status, 403);
    });

    await t.test('records both provider calls for a tool round and reaches the first threshold', async () => {
      provider = ({ messages }) => reply(tokens(30, 10), { tools: !messages.some(message => message.role === 'tool') });
      const response = await chat();
      assert.equal(response.status, 200);
      assert.equal(response.body.reply, 'Synthetic response.');
      assert.equal(Object.hasOwn(response.body, 'usage'), false);
      assert.equal(fetchImpl.mock.callCount(), 2);
      const stored = await rows();
      assert.equal(stored.length, 2);
      for (const row of stored) {
        assert.equal(new Date(row.requested_at).toISOString(), now);
        assert.equal(row.site_id, site.id);
        assert.equal(row.user_id, users.viewer.id);
        assert.equal(row.model, 'synthetic-metered');
        assert.equal(Number(row.input_tokens), 30);
        assert.equal(Number(row.output_tokens), 10);
        assert.equal(Number(row.cost_nanousd), 5_000_000_000);
        assert.equal(row.reason, null);
      }
      await summary({ estimated_cost_usd: 10, requests: 2, unpriced_requests: 0, status: 'warning' });
    });

    await t.test('retains missing usage and unpriced models and sums only known costs', async () => {
      provider = () => reply(undefined);
      assert.equal((await chat()).status, 200);
      provider = () => reply(tokens(4, undefined));
      assert.equal((await chat()).status, 200);
      provider = () => reply(tokens(2, 3), { model: 'synthetic-unpriced' });
      assert.equal((await chat()).status, 200);
      const unpriced = (await rows()).filter(row => row.reason).sort((a, b) => a.reason.localeCompare(b.reason));
      assert.deepEqual(unpriced.map(row => [row.reason, row.input_tokens == null ? null : Number(row.input_tokens),
        row.output_tokens == null ? null : Number(row.output_tokens), row.cost_nanousd]), [
        ['price_missing', 2, 3, null], ['usage_invalid', null, null, null], ['usage_missing', null, null, null],
      ]);
      provider = () => reply(tokens(20, 30));
      assert.equal((await chat()).status, 200);
      await summary({ estimated_cost_usd: 18, requests: 6, unpriced_requests: 3, status: 'critical' });
    });

    await t.test('the final admitted call reaches the limit and other sites can still call the provider', async () => {
      const started = Promise.withResolvers(), complete = Promise.withResolvers();
      const before = fetchImpl.mock.callCount();
      provider = ({ messages }) => {
        if (messages.at(-1).content === 'Other site.') return reply(undefined);
        started.resolve();
        return complete.promise;
      };
      const final = chat();
      await started.promise;
      const concurrent = chat();
      const otherChat = await request('/api/assistant/chat', { method: 'POST', cookie: cookies.verifier,
        body: { site_id: other.id, messages: [{ role: 'user', content: 'Other site.' }] } });
      complete.resolve(reply(tokens(30, 20), { tools: true }));
      assert.equal(otherChat.status, 200);
      for (const response of await Promise.all([final, concurrent, chat()])) {
        assert.equal(response.status, 429);
        assert.equal(response.body.code, 'ASSISTANT_BUDGET_EXCEEDED');
      }
      assert.equal(fetchImpl.mock.callCount() - before, 2);
      await summary({ estimated_cost_usd: 25, requests: 7, unpriced_requests: 3, status: 'blocked' });
      await summary({ estimated_cost_usd: null, requests: 1, unpriced_requests: 1, status: 'normal' }, other.id, 'verifier');
      assert.equal((await request(`/api/sites/${site.id}`, { cookie: cookies.viewer })).status, 200);
    });

    await t.test('the next UTC month starts at zero and leaves the previous ledger intact', async () => {
      t.mock.timers.setTime(Date.parse('2026-12-01T00:00:00.000Z'));
      const limiter = createLoginLimiter();
      for (const role of ['owner', 'viewer']) {
        const { token } = await login(db, {
          email: users[role].email, password: 'Synthetic-test-password!',
        }, { limiter });
        cookies[role] = `sa_session=${token}`;
      }
      const next = await usage();
      assert.equal(next.status, 200);
      assert.equal(next.body.month, '2026-12');
      assert.equal(next.body.estimated_cost_usd, 0);
      assert.equal(next.body.status, 'normal');
      provider = () => reply(tokens(1, 1));
      assert.equal((await chat()).status, 200);
      assert.equal((await usage()).body.estimated_cost_usd, 0.3);
      assert.equal((await rows()).length, 8);
    });
  });
}
