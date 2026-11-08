import test from 'node:test';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createServer } from '../server/http.mjs';
import { createSite, transitionTask } from '../server/repository.mjs';
import { isPg, openTestDb } from './helpers/db.mjs';
import { createTaskResponse } from '../server/idempotency.mjs';

// Exercise the actual HTTP request listener with byte streams, without opening
// a socket. Socket-based end-to-end coverage remains in server.test.mjs.
async function fixture(t, { race = false } = {}) {
  const database = await openTestDb();
  const { db } = database;
  t.after(database.close);
  const site = await createSite(db, { code: 'EXAMPLE-4', name: 'Example site' });
  let storage = db;
  if (race) {
    let readers = 0;
    let release;
    const bothRead = new Promise(resolve => { release = resolve; });
    storage = {
      get: async (sql, ...params) => {
        const row = await db.get(sql, ...params);
        if (sql === 'SELECT * FROM idempotency_keys WHERE key = ?' && !row) {
          readers += 1;
          if (readers === 2) release();
          await bothRead;
        }
        return row;
      },
      transaction: fn => db.transaction(fn),
      isUniqueViolation: error => db.isUniqueViolation(error),
    };
  }
  const server = createServer(storage);
  const input = { siteId: site.id, title: 'Example task', executor: 'Example executor', verifier: 'Example verifier' };
  function post(path, body, { key, raw = JSON.stringify(body), chunks, headers = {} } = {}) {
    const request = Readable.from(chunks ?? [Buffer.from(raw)]);
    request.method = 'POST';
    request.url = path;
    request.headers = { 'content-type': 'application/json', ...headers };
    if (key !== undefined) request.headers['idempotency-key'] = key;
    return new Promise(resolve => {
      const responseHeaders = {};
      const response = {
        setHeader: (name, value) => { responseHeaders[name.toLowerCase()] = value; },
        writeHead: (status, values = {}) => {
          response.status = status;
          for (const [name, value] of Object.entries(values)) response.setHeader(name, value);
        },
        end: raw => resolve({ status: response.status, raw, body: JSON.parse(raw), headers: responseHeaders }),
      };
      server.emit('request', request, response);
    });
  }
  return { db, site, input, post, reopen: database.reopen };
}

test('POST diary derives its date from one server instant and stores zone and cutoff', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-03-29T03:59:00.000Z') });
  const { post, site } = await fixture(t);
  const input = { siteId: site.id, shift: 'night' };
  const entry = await post('/api/diary', input);
  t.assert.strictEqual(entry.status, 201);
  t.assert.strictEqual(entry.body.operational_date, '2026-03-28');
  t.assert.strictEqual(entry.body.created_at, '2026-03-29T03:59:00.000Z');
  t.assert.strictEqual(entry.body.time_zone, 'Europe/Rome');
  t.assert.strictEqual(entry.body.day_cutoff_time, '06:00');
  const backdated = await post('/api/diary', { ...input, operational_date: '2026-01-01' });
  t.assert.strictEqual(backdated.status, 201);
  t.assert.strictEqual(backdated.body.operational_date, '2026-01-01');
  t.assert.strictEqual(backdated.body.time_zone, 'Europe/Rome');
  t.assert.strictEqual(backdated.body.day_cutoff_time, '06:00');
  const custom = await post('/api/diary', { ...input, time_zone: 'UTC', day_cutoff_time: '03:00' });
  t.assert.strictEqual(custom.status, 201);
  t.assert.strictEqual(custom.body.operational_date, '2026-03-29');
  t.assert.strictEqual(custom.body.time_zone, 'UTC');
  t.assert.strictEqual(custom.body.day_cutoff_time, '03:00');
  for (const extra of [
    { time_zone: 'Invalid/Zone' }, { day_cutoff_time: '24:00' },
    { operational_date: '' }, { operational_date: null },
  ]) {
    const error = await post('/api/diary', { ...input, ...extra });
    t.assert.strictEqual(error.status, 400);
    t.assert.strictEqual(error.body.code, 'VALIDATION_ERROR');
  }
});

test('POST diary derives the date after the autumn cutoff', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-25T05:00:00.000Z') });
  const { post, site } = await fixture(t);
  const result = await post('/api/diary', { siteId: site.id, shift: 'day' });
  t.assert.strictEqual(result.status, 201);
  t.assert.strictEqual(result.body.operational_date, '2026-10-25');
});

test('double POST with one key replays the saved status and exact body, including after a task changes', async t => {
  const { post, input, db } = await fixture(t);
  const first = await post('/api/tasks', input, { key: 'example-retry' });
  t.assert.strictEqual(first.status, 201);
  await transitionTask(db, first.body.id, { to: 'in_progress', actor: input.executor });
  const second = await post('/api/tasks', input, { key: 'example-retry' });
  t.assert.strictEqual(second.status, first.status);
  t.assert.strictEqual(second.raw, first.raw);
  t.assert.strictEqual((await db.all('SELECT * FROM tasks')).length, 1);
  const saved = await db.get('SELECT * FROM idempotency_keys WHERE key = ?', 'example-retry');
  t.assert.strictEqual(saved.route, 'POST /api/tasks');
  t.assert.strictEqual(saved.status, first.status);
  t.assert.strictEqual(saved.body, first.raw);
  t.assert.strictEqual(saved.request_hash, createHash('sha256').update(JSON.stringify(input)).digest('hex'));
});

test('the same key with a different body returns 409 IDEMPOTENCY_KEY_REUSED', async t => {
  const { post, input, db } = await fixture(t);
  t.assert.strictEqual((await post('/api/tasks', input, { key: 'example-conflict' })).status, 201);
  const result = await post('/api/tasks', { ...input, title: 'Another example task' }, { key: 'example-conflict' });
  t.assert.strictEqual(result.status, 409);
  t.assert.strictEqual(result.body.code, 'IDEMPOTENCY_KEY_REUSED');
  t.assert.strictEqual((await db.all('SELECT * FROM tasks')).length, 1);
});

test('hashing uses raw UTF-8 bytes, including whitespace, key order and split multibyte characters', async t => {
  const { post, input, db } = await fixture(t);
  const raw = JSON.stringify({ ...input, title: 'Example café 🧱' });
  const bytes = Buffer.from(raw);
  const chunks = Array.from(bytes, byte => Buffer.from([byte]));
  const first = await post('/api/tasks', input, { key: 'example-bytes', raw, chunks });
  t.assert.strictEqual(first.status, 201);
  const saved = await db.get('SELECT * FROM idempotency_keys WHERE key = ?', 'example-bytes');
  t.assert.strictEqual(saved.request_hash, createHash('sha256').update(bytes).digest('hex'));
  t.assert.strictEqual((await post('/api/tasks', input, { key: 'example-bytes', raw })).raw, first.raw);
  const reordered = JSON.stringify({
    title: 'Example café 🧱', siteId: input.siteId, executor: input.executor, verifier: input.verifier,
  });
  for (const different of [` ${raw}`, reordered]) {
    const conflict = await post('/api/tasks', input, { key: 'example-bytes', raw: different });
    t.assert.strictEqual(conflict.status, 409);
    t.assert.strictEqual(conflict.body.code, 'IDEMPOTENCY_KEY_REUSED');
  }
});

test('two POSTs without a key still create distinct tasks and no stored keys', async t => {
  const { post, input, db } = await fixture(t);
  const first = await post('/api/tasks', input);
  const second = await post('/api/tasks', input);
  t.assert.strictEqual(first.status, 201);
  t.assert.strictEqual(second.status, 201);
  t.assert.notStrictEqual(first.body.id, second.body.id);
  t.assert.strictEqual((await db.all('SELECT * FROM tasks')).length, 2);
  t.assert.deepStrictEqual(await db.all('SELECT * FROM idempotency_keys'), []);
});

test('concurrent POSTs race on the primary key and commit exactly one task and response', { timeout: 10000 }, async t => {
  const { post, input, db } = await fixture(t, { race: true });
  const results = await Promise.all([
    post('/api/tasks', input, { key: 'example-concurrent' }),
    post('/api/tasks', input, { key: 'example-concurrent' }),
  ]);
  t.assert.deepStrictEqual(results.map(result => result.status), [201, 201]);
  t.assert.strictEqual(results[0].raw, results[1].raw);
  t.assert.strictEqual((await db.all('SELECT * FROM tasks')).length, 1);
  t.assert.strictEqual((await db.all('SELECT * FROM idempotency_keys')).length, 1);
});

test('concurrent POSTs with different bodies commit one task and reject the losing request', { timeout: 10000 }, async t => {
  const { post, input, db } = await fixture(t, { race: true });
  const results = await Promise.all([
    post('/api/tasks', input, { key: 'example-racing-conflict' }),
    post('/api/tasks', { ...input, title: 'Another example task' }, { key: 'example-racing-conflict' }),
  ]);
  t.assert.deepStrictEqual(results.map(result => result.status).sort(), [201, 409]);
  t.assert.strictEqual(results.find(result => result.status === 409).body.code, 'IDEMPOTENCY_KEY_REUSED');
  t.assert.strictEqual((await db.all('SELECT * FROM tasks')).length, 1);
  t.assert.strictEqual((await db.all('SELECT * FROM idempotency_keys')).length, 1);
});

test('failed task validation rolls back the key reservation and permits a corrected retry', async t => {
  const { post, input, db } = await fixture(t);
  const invalid = await post('/api/tasks', { ...input, title: '' }, { key: 'example-correction' });
  t.assert.strictEqual(invalid.status, 400);
  t.assert.deepStrictEqual(await db.all('SELECT * FROM tasks'), []);
  t.assert.deepStrictEqual(await db.all('SELECT * FROM idempotency_keys'), []);
  t.assert.strictEqual((await post('/api/tasks', input, { key: 'example-correction' })).status, 201);
});

test('failure while storing the response rolls back both the task and its reservation', async t => {
  if (isPg) { t.skip('Uses a SQLite RAISE trigger.'); return; }
  const { db, input } = await fixture(t);
  await db.exec(`CREATE TRIGGER fail_response BEFORE UPDATE ON idempotency_keys
    BEGIN SELECT RAISE(ABORT, 'Synthetic response failure'); END;`);
  const options = { key: 'example-rollback', requestHash: createHash('sha256').update(JSON.stringify(input)).digest('hex') };
  await t.assert.rejects(() => createTaskResponse(db, input, options), /Synthetic response failure/);
  t.assert.deepStrictEqual(await db.all('SELECT * FROM tasks'), []);
  t.assert.deepStrictEqual(await db.all('SELECT * FROM idempotency_keys'), []);
  await db.exec('DROP TRIGGER fail_response');
  t.assert.strictEqual((await createTaskResponse(db, input, options)).status, 201);
});

test('task POST permits the idempotency header for the existing allowed origin', async t => {
  const { post, input } = await fixture(t);
  const result = await post('/api/tasks', input, {
    key: 'example-cors', headers: { origin: 'https://siteassistant.asassi.cloud' },
  });
  t.assert.strictEqual(result.status, 201);
  t.assert.match(result.headers['access-control-allow-headers'], /Idempotency-Key/i);
});
