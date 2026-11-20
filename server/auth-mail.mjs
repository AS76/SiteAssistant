import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export class MailNotConfiguredError extends Error {
  constructor() { super('Transactional email is not configured.'); this.code = 'MAIL_NOT_CONFIGURED'; }
}
export class MailDeliveryError extends Error {
  constructor() { super('Transactional email is temporarily unavailable.'); this.code = 'MAIL_UNAVAILABLE'; }
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Read once; templates are pure functions of their arguments and this cached asset.
let logo = '';
try { logo = readFileSync(new URL('../app/assets/logo.svg', import.meta.url)).toString('base64'); } catch { /* Text wordmark below remains available. */ }
function template(subject, content, text) {
  return { subject, text, html: `<!doctype html><html lang="en"><body style="margin:0;padding:24px;background:#d1e7c0;color:#142c30;font-family:Arial,sans-serif"><main style="max-width:560px;margin:auto;padding:28px;background:white;border-radius:12px">${logo ? `<img src="data:image/svg+xml;base64,${logo}" width="250" height="66" alt="SiteAssistant">` : '<strong style="color:#126c57;font-size:24px">SiteAssistant</strong>'}<h1 style="font-size:22px;color:#126c57">${escapeHtml(subject)}</h1>${content}<p style="font-size:12px">SiteAssistant</p></main></body></html>` };
}
export function signupNotifyEmail({ email, reviewUrl }) {
  return template('SiteAssistant access request', `<p>Access requested for <strong>${escapeHtml(email)}</strong>.</p><p>This link expires in 72 hours. Review the request before approving or rejecting it:</p><p><a style="color:#126c57" href="${escapeHtml(reviewUrl)}">Review request</a></p>`, `SiteAssistant access request\nEmail: ${email}\nLink expires in 72 hours. Review the request before approving or rejecting it.\nReview request: ${reviewUrl}`);
}
export function welcomeEmail({ password }) {
  return template('Welcome to SiteAssistant', `<p>Your access request has been approved.</p><p>Temporary password: <strong>${escapeHtml(password)}</strong></p><p>Sign in and change this password using the password banner.</p>`, `Your SiteAssistant access request has been approved.\nTemporary password: ${password}\nSign in and change this password using the password banner.`);
}
export function resetEmail({ password }) {
  return template('SiteAssistant password reset', `<p>A password reset was requested for your account. Previous sessions have been revoked.</p><p>Temporary password: <strong>${escapeHtml(password)}</strong></p><p>Sign in and change this password using the password banner.</p>`, `A SiteAssistant password reset was requested for your account. Previous sessions have been revoked.\nTemporary password: ${password}\nSign in and change this password using the password banner.`);
}

const mailbox = value => typeof value === 'string' && value.length <= 254 && /^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+\.[^\s@<>\x00-\x1f\x7f]+$/.test(value);
function configuration(env) {
  const port = Number(env.SMTP_PORT || 587), from = env.SMTP_FROM || env.EMAIL;
  if (!env.SMTP_HOST || ![465, 587].includes(port) || !mailbox(env.EMAIL) || !mailbox(from) || !env.EMAIL_PASSWORD) throw new MailNotConfiguredError();
  return { host: env.SMTP_HOST, port, from, email: env.EMAIL, password: env.EMAIL_PASSWORD };
}

// A single command is in flight. Buffer complete multiline replies, including
// greetings that arrive before the caller starts waiting for them.
function replies(socket) {
  let buffer = '', lines = [], queue = [], waiting, failure;
  const fail = () => { failure = new MailDeliveryError(); if (waiting) { waiting.reject(failure); waiting = null; } };
  const data = chunk => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 65536 || lines.length > 100) { fail(); socket.destroy(); return; }
    let end;
    while ((end = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (!/^\d{3}[ -]/.test(line) || (lines.length && line.slice(0, 3) !== lines[0].slice(0, 3))) { fail(); socket.destroy(); return; }
      lines.push(line);
      if (line[3] === ' ') {
        const reply = { code: Number(line.slice(0, 3)), lines }; lines = [];
        if (waiting) { waiting.resolve(reply); waiting = null; } else queue.push(reply);
      }
    }
  };
  socket.on('data', data); socket.on('error', fail); socket.on('close', fail); socket.on('end', fail);
  return {
    next: () => queue.length ? Promise.resolve(queue.shift()) : failure ? Promise.reject(failure) : new Promise((resolve, reject) => { waiting = { resolve, reject }; }),
    detach() { socket.off('data', data); socket.off('error', fail); socket.off('close', fail); socket.off('end', fail); },
  };
}
function opened(socket, event) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { socket.off(event, ready); socket.off('error', fail); socket.off('close', fail); };
    const ready = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new MailDeliveryError()); };
    socket.once(event, ready); socket.once('error', fail); socket.once('close', fail);
  });
}
const base64Lines = text => Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
function mime({ to, subject, text, html }, from) {
  if (!mailbox(to) || typeof subject !== 'string' || /[\r\n]/.test(subject) || typeof text !== 'string' || !text || typeof html !== 'string' || !html) throw new MailDeliveryError();
  const boundary = `sa-${randomUUID()}`;
  return [`From: ${from}`, `To: ${to}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${randomUUID()}@${from.split('@')[1]}>`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    ...['plain', 'html'].flatMap(type => [`--${boundary}`, `Content-Type: text/${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', base64Lines(type === 'plain' ? text : html)]), `--${boundary}--`, ''].join('\r\n');
}

export function createSmtpMailer({ env = process.env, connect = netConnect, connectTls = tlsConnect, timeoutMs = 15000 } = {}) {
  const send = async message => {
    const config = configuration(env);
    const body = mime(message, config.from);
    let socket, reader, timer;
    try {
      socket = config.port === 465 ? connectTls({ host: config.host, port: config.port, servername: config.host, rejectUnauthorized: true }) : connect({ host: config.host, port: config.port });
      // An absolute deadline bounds connection, TLS negotiation and SMTP replies.
      timer = setTimeout(() => socket.destroy(new MailDeliveryError()), timeoutMs);
      reader = replies(socket);
      await opened(socket, config.port === 465 ? 'secureConnect' : 'connect');
      const expect = async codes => { const reply = await reader.next(); if (!codes.includes(reply.code)) throw new MailDeliveryError(); return reply; };
      const command = async (line, codes) => { socket.write(`${line}\r\n`); return await expect(codes); };
      await expect([220]);
      let capabilities = await command('EHLO siteassistant', [250]);
      if (config.port === 587) {
        if (!capabilities.lines.some(line => /^250[ -]STARTTLS\b/i.test(line))) throw new MailDeliveryError();
        await command('STARTTLS', [220]);
        reader.detach();
        socket = connectTls({ socket, servername: config.host, rejectUnauthorized: true });
        reader = replies(socket);
        await opened(socket, 'secureConnect');
        capabilities = await command('EHLO siteassistant', [250]);
      }
      const auth = capabilities.lines.find(line => /^250[ -]AUTH[ =]/i.test(line)) || '';
      if (/\bPLAIN\b/i.test(auth)) {
        const credentials = Buffer.from(`\0${config.email}\0${config.password}`).toString('base64');
        const result = await command(`AUTH PLAIN ${credentials}`, [235, 334]);
        if (result.code === 334) await command(credentials, [235]);
      } else if (/\bLOGIN\b/i.test(auth)) {
        await command('AUTH LOGIN', [334]);
        await command(Buffer.from(config.email).toString('base64'), [334]);
        await command(Buffer.from(config.password).toString('base64'), [235]);
      } else throw new MailDeliveryError();
      await command(`MAIL FROM:<${config.from}>`, [250]);
      await command(`RCPT TO:<${message.to}>`, [250, 251]);
      await command('DATA', [354]);
      // MIME parts use base64; dot-stuff the envelope too for completeness.
      await command(`${body.replace(/^\./gm, '..')}\r\n.`, [250]);
      // Once DATA is acknowledged, QUIT failure must not undo accepted mail.
      try { await command('QUIT', [221]); } catch { /* Delivery was acknowledged. */ }
      socket.end();
    } catch {
      throw new MailDeliveryError();
    } finally {
      clearTimeout(timer);
      if (socket) socket.destroy();
    }
  };
  send.assertConfigured = () => { configuration(env); };
  return send;
}
export const sendMail = createSmtpMailer();
