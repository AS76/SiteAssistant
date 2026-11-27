import test from 'node:test';
import { createHttpMailer, MailDeliveryError, MailNotConfiguredError } from '../server/auth-mail.mjs';

const env = { MAIL_API_URL: 'https://relay.example.invalid/send', MAIL_API_TOKEN: 'synthetic-relay-token' };
const message = {
  to: 'recipient@example.invalid',
  subject: 'Synthetic relay message',
  text: 'Plain text',
  html: '<p>HTML text</p>',
};

function sanitized(t, ErrorType, ...values) {
  return error => {
    t.assert.ok(error instanceof ErrorType);
    for (const value of [env.MAIL_API_URL, env.MAIL_API_TOKEN, ...values]) {
      t.assert.ok(!error.message.includes(value), 'The error message must omit relay configuration');
    }
    return true;
  };
}

test('mail relay posts the authenticated message over HTTPS and reads the full success body', async t => {
  let call;
  let completed = false;
  const response = new Response(new ReadableStream({
    start(stream) { stream.enqueue(new Uint8Array([1])); },
    pull(stream) { completed = true; stream.close(); },
  }), { status: 202 });
  const send = createHttpMailer({
    env,
    fetchImpl: async (url, options) => { call = { url, options }; return response; },
  });

  await send({ ...message, extra: 'not forwarded' });

  t.assert.strictEqual(call.url, env.MAIL_API_URL);
  t.assert.strictEqual(call.options.method, 'POST');
  t.assert.strictEqual(call.options.redirect, 'error');
  t.assert.strictEqual(call.options.headers.authorization, `Bearer ${env.MAIL_API_TOKEN}`);
  t.assert.strictEqual(call.options.headers['content-type'], 'application/json');
  t.assert.deepStrictEqual(JSON.parse(call.options.body), message);
  t.assert.ok(response.bodyUsed);
  t.assert.ok(completed);
});

for (const [scenario, config] of [
  ['an HTTP URL', { ...env, MAIL_API_URL: 'http://relay.example.invalid/send' }],
  ['a malformed URL', { ...env, MAIL_API_URL: 'invalid-relay-url' }],
  ['a missing URL', { MAIL_API_TOKEN: env.MAIL_API_TOKEN }],
  ['a missing token', { MAIL_API_URL: env.MAIL_API_URL }],
]) {
  test(`mail relay rejects ${scenario} before calling fetch`, async t => {
    const fetchImpl = t.mock.fn();
    const send = createHttpMailer({ env: config, fetchImpl });
    const checkError = sanitized(t, MailNotConfiguredError, ...(config.MAIL_API_URL ? [config.MAIL_API_URL] : []));

    t.assert.throws(send.assertConfigured, checkError);
    await t.assert.rejects(() => send(message), checkError);
    t.assert.strictEqual(fetchImpl.mock.callCount(), 0);
  });
}

test('mail relay rejects a 302 and makes no request to the redirect target', async t => {
  const location = 'http://redirect.example.invalid/send';
  const response = new Response('Redirecting', { status: 302, headers: { location } });
  const fetchImpl = t.mock.fn(async () => response);
  const send = createHttpMailer({ env, fetchImpl });

  await t.assert.rejects(() => send(message), sanitized(t, MailDeliveryError, location));

  t.assert.strictEqual(fetchImpl.mock.callCount(), 1);
  const [url, options] = fetchImpl.mock.calls[0].arguments;
  t.assert.strictEqual(url, env.MAIL_API_URL);
  t.assert.strictEqual(options.redirect, 'error');
  t.assert.ok(response.bodyUsed);
});

for (const status of [401, 500]) {
  test(`mail relay reads the error body and rejects HTTP ${status}`, async t => {
    const response = new Response(`${env.MAIL_API_URL} ${env.MAIL_API_TOKEN}`, { status });
    const send = createHttpMailer({ env, fetchImpl: async () => response });

    await t.assert.rejects(() => send(message), sanitized(t, MailDeliveryError));
    t.assert.ok(response.bodyUsed);
  });
}

test('mail relay sanitizes errors thrown by fetch', async t => {
  const send = createHttpMailer({
    env,
    fetchImpl: async () => { throw new Error(`${env.MAIL_API_URL} ${env.MAIL_API_TOKEN}`); },
  });

  await t.assert.rejects(() => send(message), sanitized(t, MailDeliveryError));
});

test('mail relay aborts a response stalled after the headers', { timeout: 2000 }, async t => {
  let signal;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { status: 202 });
  const send = createHttpMailer({
    env,
    timeoutMs: 20,
    fetchImpl: async (url, options) => { signal = options.signal; return response; },
  });

  await t.assert.rejects(() => send(message), sanitized(t, MailDeliveryError));
  t.assert.ok(signal.aborted);
  t.assert.ok(cancelled);
});
