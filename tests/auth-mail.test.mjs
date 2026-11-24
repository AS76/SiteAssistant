import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createSmtpMailer, createHttpMailer, MailNotConfiguredError, MailDeliveryError, signupNotifyEmail, welcomeEmail, resetEmail } from '../server/auth-mail.mjs';

const env = { SMTP_HOST: 'smtp.example.invalid', SMTP_PORT: '587', EMAIL: 'sender@example.invalid', EMAIL_PASSWORD: 'Synthetic-smtp-password' };
const message = { to: 'recipient@example.invalid', ...welcomeEmail({ password: 'Synthetic-password!' }) };
// Scripted sockets exercise the SMTP protocol without opening ports or sending mail.
function transport({ port = 587, auth = 'PLAIN', starttls = true, rejectRecipient = false, stall = false, quitFailure = false, authChallenge = false } = {}) {
  const commands = [], sockets = [];
  let encrypted = port === 465, loginStep = 0, data = false;
  class Socket extends EventEmitter {
    destroyed = false;
    write(chunk) {
      commands.push({ encrypted, text: chunk });
      if (stall) return;
      let response;
      if (data) { data = false; response = '250 Message accepted'; }
      else if (chunk.startsWith('EHLO')) response = `250-example.invalid\r\n${!encrypted && starttls ? '250-STARTTLS\r\n' : ''}250 AUTH ${auth}`;
      else if (chunk.startsWith('STARTTLS')) response = '220 Upgrade ready';
      else if (chunk.startsWith('AUTH PLAIN')) { response = authChallenge ? '334 Continue' : '235 Authenticated'; if (authChallenge) loginStep = 2; }
      else if (chunk.startsWith('AUTH LOGIN')) { response = '334 Username'; loginStep = 1; }
      else if (loginStep) { response = loginStep++ === 1 ? '334 Password' : '235 Authenticated'; if (loginStep > 2) loginStep = 0; }
      else if (chunk.startsWith('MAIL FROM')) response = '250 Sender accepted';
      else if (chunk.startsWith('RCPT TO')) response = rejectRecipient ? '550 Recipient rejected' : '250 Recipient accepted';
      else if (chunk.startsWith('DATA')) { response = '354 Send message'; data = true; }
      else if (chunk.startsWith('QUIT')) { if (quitFailure) { this.destroy(); return; } response = '221 Goodbye'; }
      else throw new Error('Unexpected SMTP command');
      queueMicrotask(() => {
        // Fragmented responses exercise line buffering and multiline EHLO.
        this.emit('data', Buffer.from(response.slice(0, 7)));
        this.emit('data', Buffer.from(response.slice(7) + '\r\n'));
      });
    }
    end() { this.ended = true; }
    destroy(error) { if (this.destroyed) return; this.destroyed = true; if (error) this.emit('error', error); this.emit('close'); }
  }
  function socket(event, greeting) {
    const result = new Socket(); sockets.push(result);
    queueMicrotask(() => { result.emit(event); if (greeting && !stall) result.emit('data', Buffer.from('220 SMTP ready\r\n')); });
    return result;
  }
  return {
    commands, sockets,
    connect: () => socket('connect', true),
    connectTls: options => {
      if (options.rejectUnauthorized !== true || options.servername !== env.SMTP_HOST) throw new Error('TLS verification missing');
      encrypted = true;
      if (options.socket) options.socket.destroyed = true;
      return socket('secureConnect', !options.socket);
    },
  };
}

test('email templates include escaped inline HTML, embedded logo and readable text alternatives', t => {
  const notification = signupNotifyEmail({ email: '<applicant>@example.invalid', reviewUrl: 'https://app.example.invalid/api/auth/request/decide?token=synthetic' });
  for (const mail of [notification, welcomeEmail({ password: '<synthetic-password>' }), resetEmail({ resetUrl: 'https://app.example.invalid/api/auth/reset?token=synthetic' })]) {
    t.assert.ok(mail.text.length > 40); t.assert.ok(mail.subject);
    t.assert.match(mail.html, /data:image\/svg\+xml;base64,/);
    t.assert.match(mail.html, /#126c57/); t.assert.match(mail.html, /#d1e7c0/); t.assert.match(mail.html, /#142c30/);
    t.assert.doesNotMatch(mail.html, /<img[^>]+src="https?:|<link|<script|<applicant>|<synthetic-password>/);
  }
  t.assert.strictEqual((notification.html.match(/<a\b/g) || []).length, 1);
  t.assert.strictEqual((notification.text.match(/https:\/\//g) || []).length, 1);
  t.assert.match(notification.html, />Review request<\/a>/);
  t.assert.match(notification.text, /Review request: https:.*\/api\/auth\/request\/decide\?token=synthetic/);
  t.assert.doesNotMatch(notification.html + notification.text, /decision=|Approve:|Reject:/);
});

for (const [port, auth, authChallenge] of [[587, 'PLAIN', false], [465, 'LOGIN', false], [465, 'PLAIN', true]]) {
  test(`SMTP ${port} ${auth} sends multipart email only after TLS and authentication`, async t => {
    const fake = transport({ port, auth, authChallenge });
    await createSmtpMailer({ env: { ...env, SMTP_PORT: String(port) }, ...fake })(message);
    t.assert.ok(fake.commands.filter(c => /AUTH|MAIL FROM|RCPT TO/.test(c.text)).every(c => c.encrypted));
    t.assert.strictEqual(fake.commands.some(c => c.text === 'STARTTLS\r\n'), port === 587);
    const payload = fake.commands.find(c => c.text.startsWith('From:')).text;
    t.assert.match(payload, /multipart\/alternative/);
    t.assert.match(payload, /Content-Type: text\/plain/); t.assert.match(payload, /Content-Type: text\/html/);
    t.assert.ok(payload.includes(Buffer.from(message.text).toString('base64').slice(0, 76)));
    t.assert.match(fake.commands.at(-1).text, /QUIT/);
    t.assert.ok(fake.sockets.every(s => s.destroyed));
  });
}

test('SMTP fails closed without STARTTLS, on rejection and on timeout, without leaking credentials', async t => {
  for (const scenario of [{ starttls: false }, { rejectRecipient: true }, { stall: true }]) {
    const fake = transport(scenario);
    const send = createSmtpMailer({ env, ...fake, timeoutMs: 20 });
    await t.assert.rejects(() => send(message), error => error instanceof MailDeliveryError && !error.message.includes(env.EMAIL_PASSWORD));
    t.assert.ok(fake.sockets.every(s => s.destroyed));
    if (scenario.starttls === false) t.assert.ok(!fake.commands.some(c => c.text.startsWith('AUTH')));
  }
});

test('SMTP accepts acknowledged DATA even if QUIT fails; configuration and header validation precede connection', async t => {
  const fake = transport({ quitFailure: true });
  await createSmtpMailer({ env, ...fake })(message);
  const noConnect = () => { throw new Error('Must not open a socket'); };
  for (const config of [{}, { ...env, SMTP_PORT: '25' }, { ...env, EMAIL_PASSWORD: '' }]) {
    await t.assert.rejects(() => createSmtpMailer({ env: config, connect: noConnect })(message), MailNotConfiguredError);
  }
  await t.assert.rejects(() => createSmtpMailer({ env, connect: noConnect })({ ...message, to: 'victim@example.invalid\r\nBcc: another@example.invalid' }), MailDeliveryError);
});

test('HTTP mailer posts the message to the authenticated relay', async t => {
  let call;
  const mailer = createHttpMailer({
    env: { MAIL_API_URL: 'https://relay.example.invalid/send', MAIL_API_TOKEN: 'synthetic-token' },
    fetchImpl: async (url, options) => { call = { url, options }; return { ok: true, status: 202 }; },
  });
  await mailer(message);
  t.assert.strictEqual(call.url, 'https://relay.example.invalid/send');
  t.assert.strictEqual(call.options.method, 'POST');
  t.assert.strictEqual(call.options.headers.authorization, 'Bearer synthetic-token');
  t.assert.deepStrictEqual(JSON.parse(call.options.body), { to: message.to, subject: message.subject, text: message.text, html: message.html });
});

test('HTTP mailer fails closed on configuration, non-2xx and timeout', async t => {
  t.assert.throws(() => createHttpMailer({ env: {} }).assertConfigured(), MailNotConfiguredError);
  const rejected = createHttpMailer({ env: { MAIL_API_URL: 'https://relay.example.invalid/send', MAIL_API_TOKEN: 'x' }, fetchImpl: async () => ({ ok: false, status: 502 }) });
  await t.assert.rejects(() => rejected(message), MailDeliveryError);
  const stalled = createHttpMailer({
    env: { MAIL_API_URL: 'https://relay.example.invalid/send', MAIL_API_TOKEN: 'x' },
    timeoutMs: 10,
    fetchImpl: (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  await t.assert.rejects(() => stalled(message), MailDeliveryError);
});
