import test from 'node:test';
import { createHash } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import { S3Storage, signS3Request } from '../server/s3.mjs';

// Invented values only; no provider account is used by these tests.
const env = { S3_ENDPOINT: 'https://storage.example.invalid', S3_BUCKET: 'synthetic-bucket',
  S3_ACCESS_KEY: 'synthetic-access-key', S3_SECRET_KEY: 'synthetic-secret' };
const now = () => new Date('2026-01-01T00:00:00.000Z');
const data = Buffer.from('Synthetic content');
const sha256 = createHash('sha256').update(data).digest('hex');

test('SigV4 PUT/GET/HEAD/DELETE match fixed independently calculated synthetic vectors', t => {
  // Calculated separately with Python hashlib/hmac and explicit canonical strings.
  const signatures = {
    PUT: '2ba7667853c99d2ad35b6c549cf6d3145884dd363ad9a1bf86ca324b8db4caee',
    GET: 'c685ef54f85a6f24404fce4eeff6d42c28fb42c29457cd6bad97366bf9c03835',
    HEAD: 'f05ba7684a6855eba755b0e41365e1b1ad026e3f78e23fec41fd6422362ca989',
    DELETE: 'f5396b14fc33b0a608d8d34d5e9c30faddf687c9baaf4937d48be53852c91301',
  };
  for (const [method, signature] of Object.entries(signatures)) {
    const headers = signS3Request({ method, url: new URL('https://storage.example.invalid/synthetic-bucket/a%20b%2B%25.txt'),
      accessKey: env.S3_ACCESS_KEY, secretKey: env.S3_SECRET_KEY, now: now(), ...(method === 'PUT' ? { body: data } : {}) });
    t.assert.strictEqual(headers.authorization,
      `AWS4-HMAC-SHA256 Credential=synthetic-access-key/20260101/us-east-1/s3/aws4_request,SignedHeaders=host;x-amz-content-sha256;x-amz-date,Signature=${signature}`);
  }
});

test('S3 adapter encodes keys once, signs create-only PUT, reads HEAD and streams GET without network', async t => {
  const calls = [];
  const storage = new S3Storage({ env, now, fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(data.length), 'x-amz-meta-sha256': sha256 } });
    if (options.method === 'GET') return new Response(data);
    return new Response(null, { status: 204 });
  } });
  const key = "images//résumé +%!'()*.pdf";
  await storage.put(key, data, { mime: 'application/pdf', sha256 });
  t.assert.deepStrictEqual(await storage.head(key), { size: data.length, sha256 });
  t.assert.deepStrictEqual(await buffer(await storage.get(key)), data);
  await storage.delete(key);
  t.assert.deepStrictEqual(calls.map(call => call.method), ['PUT', 'HEAD', 'GET', 'DELETE']);
  for (const call of calls) {
    t.assert.strictEqual(call.url.href, 'https://storage.example.invalid/synthetic-bucket/images//r%C3%A9sum%C3%A9%20%2B%25%21%27%28%29%2A.pdf');
    t.assert.strictEqual(call.redirect, 'error');
    t.assert.ok(call.signal instanceof AbortSignal);
    t.assert.match(call.headers.authorization, /Signature=[a-f0-9]{64}$/);
  }
  const put = calls[0];
  t.assert.strictEqual(put.headers['if-none-match'], '*');
  t.assert.strictEqual(put.headers['x-amz-meta-sha256'], sha256);
  t.assert.strictEqual(put.headers['x-amz-content-sha256'], sha256);
  t.assert.match(put.headers.authorization, /SignedHeaders=content-length;content-type;host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256/);
  t.assert.strictEqual(put.body, data);
});

test('S3 configuration and upstream errors never expose credentials, endpoints or provider responses', async t => {
  const noNetwork = async () => { throw new Error('Transport must not be called'); };
  for (const invalid of [{}, { ...env, S3_ENDPOINT: 'http://storage.example.invalid' },
    { ...env, S3_ENDPOINT: 'https://storage.example.invalid/?signature=private' }, { ...env, S3_BUCKET: '../bad' }]) {
    await t.assert.rejects(() => new S3Storage({ env: invalid, fetchImpl: noNetwork }).head('key'), { code: 'STORAGE_NOT_CONFIGURED' });
  }
  for (const key of ['../key', 'a/../key', './key', '']) {
    await t.assert.rejects(() => new S3Storage({ env, fetchImpl: noNetwork }).head(key), { code: 'STORAGE_NOT_CONFIGURED' });
  }
  for (const status of [301, 403, 404, 412, 500]) {
    const storage = new S3Storage({ env, fetchImpl: async () => new Response('Synthetic private provider response', { status }) });
    await t.assert.rejects(() => storage.head('key'), error => {
      t.assert.strictEqual(error.message, 'Attachment storage operation failed.');
      t.assert.strictEqual(error.code, status === 412 ? 'STORAGE_CONFLICT' : 'STORAGE_UNAVAILABLE');
      return true;
    });
  }
  const missing = new S3Storage({ env, fetchImpl: async () => new Response(null, { status: 404 }) });
  await missing.delete('key');
  const offline = new S3Storage({ env, fetchImpl: async () => { throw new Error('Synthetic transport secret'); } });
  await t.assert.rejects(() => offline.get('key'), { message: 'Attachment storage operation failed.', code: 'STORAGE_UNAVAILABLE' });
});

test('S3 HEAD does not treat ETag or missing size as verified SHA-256', async t => {
  const storage = new S3Storage({ env, fetchImpl: async () => new Response(null, { headers: { etag: 'synthetic-etag' } }) });
  const head = await storage.head('key');
  t.assert.strictEqual(head.sha256, null);
  t.assert.ok(Number.isNaN(head.size));
});
