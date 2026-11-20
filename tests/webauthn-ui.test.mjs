import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { browserOptions, credentialJSON, fromBase64url, toBase64url, supportsPasskeys, runPasskey } from '../app/webauthn-client.mjs';
import { createApi } from '../app/api.mjs';
import { messages } from '../app/i18n.mjs';
const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
const bytes = Uint8Array.of(0, 255, 254, 128);
const encoded = toBase64url(bytes);
const credential = { id: encoded, rawId: bytes.buffer, type: 'public-key',
  response: { clientDataJSON: bytes.buffer, authenticatorData: bytes.buffer, signature: bytes.buffer, userHandle: null },
  getClientExtensionResults: () => ({}) };
const environment = method => ({ isSecureContext: true, PublicKeyCredential: class {}, navigator: { credentials: { create: method, get: method } } });

test('base64url handles binary values and views without mutation', () => {
  assert.deepEqual(fromBase64url(encoded), bytes);
  assert.equal(toBase64url(bytes.subarray(1, 3)), '__4');
  const wire = { challenge_id: 'synthetic-challenge', challenge: encoded, user: { id: encoded }, excludeCredentials: [{ id: encoded, transports: ['internal'] }] };
  const before = structuredClone(wire), options = browserOptions(wire);
  assert.equal('challenge_id' in options, false);
  assert.deepEqual(options.challenge, bytes);
  assert.deepEqual(options.user.id, bytes);
  assert.deepEqual(options.excludeCredentials[0].id, bytes);
  assert.deepEqual(wire, before);
  assert.equal(credentialJSON(credential).response.userHandle, undefined);
});

test('native login and registration send explicit envelopes and preserve API errors', async () => {
  for (const kind of ['login', 'register']) {
    let verified, requested;
    const response = kind === 'register' ? { ...credential, response: { clientDataJSON: bytes.buffer, attestationObject: bytes.buffer, getTransports: () => ['internal'] } } : credential;
    const options = { challenge_id: 'synthetic-challenge', challenge: encoded, ...(kind === 'register' ? { user: { id: encoded } } : { allowCredentials: [{ id: encoded }] }) };
    const api = {
      passkeyLoginOptions: async input => { requested = input; return options; }, passkeyRegisterOptions: async () => options,
      passkeyLoginVerify: async input => { verified = input; return 'ok'; }, passkeyRegisterVerify: async input => { verified = input; return 'ok'; },
    };
    const env = environment(async input => {
      assert.deepEqual(Object.keys(input), ['publicKey']);
      assert.equal('challenge_id' in input.publicKey, false);
      return response;
    });
    assert.equal(await runPasskey(api, kind, { discoverable: true }, env), 'ok');
    assert.deepEqual(Object.keys(verified), ['challenge_id', 'response']);
    assert.equal(verified.challenge_id, options.challenge_id);
    assert.equal(verified.response.response.clientDataJSON, encoded);
    if (kind === 'login') assert.deepEqual(requested, { discoverable: true });
    else assert.deepEqual(verified.response.response.transports, ['internal']);
    const failure = Object.assign(new Error('Synthetic server failure'), { code: 'LAST_CREDENTIAL', status: 409 });
    api[kind === 'register' ? 'passkeyRegisterVerify' : 'passkeyLoginVerify'] = async () => { throw failure; };
    await assert.rejects(runPasskey(api, kind, {}, env), error => error === failure);
  }
});

test('unsupported browsers and cancelled prompts have translatable failures', async () => {
  assert.equal(supportsPasskeys({}), false);
  await assert.rejects(runPasskey({}, 'login', {}, {}), /passkeyUnsupported/);
  const api = { passkeyLoginOptions: async () => ({ challenge: encoded }) };
  for (const name of ['NotAllowedError', 'AbortError', 'InvalidStateError', 'UnknownError']) {
    await assert.rejects(runPasskey(api, 'login', {}, environment(async () => { throw { name }; })), error => Boolean(messages.en[error.message] && messages.it[error.message]));
  }
});

test('API routes, verbs, cookies and login failure isolation', async () => {
  const calls = []; let unauthorized = 0;
  const api = createApi({ baseUrl: 'https://example.invalid', onUnauthorized: () => unauthorized++, fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith('/login/verify')) return Response.json({ error: 'Synthetic verification failure', code: 'INVALID_CREDENTIALS' }, { status: 401 });
    return Response.json([]);
  } });
  await api.passkeyLoginOptions({ email: 'user@example.invalid' });
  await assert.rejects(api.passkeyLoginVerify({ challenge_id: 'challenge', response: {} }), { code: 'INVALID_CREDENTIALS' });
  assert.equal(unauthorized, 0);
  await api.passkeyRegisterOptions(); await api.passkeyRegisterVerify({ challenge_id: 'challenge', response: {} });
  const unauthorizedBefore = unauthorized;
  await assert.rejects(createApi({ baseUrl: 'https://example.invalid', onUnauthorized: () => unauthorized++, fetchImpl: async () => Response.json({ error: 'Synthetic registration failure', code: 'INVALID_CREDENTIALS' }, { status: 401 }) }).passkeyRegisterVerify({ challenge_id: 'challenge', response: {} }), { code: 'INVALID_CREDENTIALS' });
  assert.equal(unauthorized, unauthorizedBefore);
  await api.listCredentials(); await api.renameCredential('id /', 'New name'); await api.deleteCredential('id /');
  assert.deepEqual(calls.map(call => call.method || 'GET'), ['POST', 'POST', 'POST', 'POST', 'GET', 'PATCH', 'DELETE']);
  assert.ok(calls.every(call => call.credentials === 'include'));
  assert.ok(calls[5].url.endsWith('/api/auth/credentials/id%20%2F'));
  assert.deepEqual(JSON.parse(calls[5].body), { name: 'New name' });
});

function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
test('login renders password fallback and both passkey choices in IT and EN', () => {
  for (const language of ['it', 'en']) {
    const main = { setAttribute() {} };
    const context = createContext({ session: null, loadError: null, view: 'overview', document: { body: { classList: { toggle() {} } } }, loading: false, renderChrome() {}, renderOffline() {}, $: () => main,
      t: key => { assert.ok(messages[language][key], key); return messages[language][key]; },
      button: (key, command) => `<button data-command="${command}">${messages[language][key]}</button>`, supportsPasskeys: () => true });
    runInContext(section('function render() {', 'function showModal('), context);
    runInContext('render()', context);
    assert.match(main.innerHTML, /autocomplete="current-password" required/);
    assert.match(main.innerHTML, /name="email" type="email"/);
    assert.ok(main.innerHTML.includes(messages[language].passkeyLogin));
    assert.ok(main.innerHTML.includes(messages[language].passkeyDiscoverable));
  }
});

test('security modal renders escaped metadata, controls, empty and server failure states', async () => {
  for (const language of ['it', 'en']) {
    let rows = [{ id: 'synthetic-id', name: '<synthetic>', created_at: '2026-01-01T00:00:00Z', last_used_at: null }];
    const alert = { focus() {} };
    const panel = { isConnected: true, innerHTML: '', querySelector: () => alert };
    const modal = {};
    const context = createContext({ session: { user: { id: 'synthetic-user' } }, modalVersion: 1,
      api: { listCredentials: async () => { if (rows instanceof Error) throw rows; return rows; } },
      showModal() {}, $: key => key === '#passkey-panel' ? panel : modal,
      t: key => { assert.ok(messages[language][key], key); return messages[language][key]; },
      supportsPasskeys: () => true, timeLabel: value => value,
      esc: value => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      button: key => `<button>${messages[language][key]}</button>`, modalFormState: () => '', passkeyError: error => error.message });
    runInContext(section('async function showPasskeySecurity()', 'async function submitPasskeyForm(event) {'), context);
    await runInContext('showPasskeySecurity()', context);
    assert.ok(panel.innerHTML.includes('&lt;synthetic&gt;'));
    for (const key of ['passkeyName', 'passkeyCreated', 'passkeyLastUsed', 'passkeyNever', 'passkeyRename', 'passkeyDelete', 'passkeyAdd']) assert.ok(panel.innerHTML.includes(messages[language][key]), key);
    rows = []; await runInContext('showPasskeySecurity()', context);
    assert.ok(panel.innerHTML.includes(messages[language].passkeyEmpty));
    rows = new Error('Synthetic server failure'); await runInContext('showPasskeySecurity()', context);
    assert.match(panel.innerHTML, /role="alert".*Synthetic server failure/);
  }
});

test('every new passkey translation is present in both languages', () => {
  const keys = Object.keys(messages.it).filter(key => key.startsWith('passkey'));
  assert.ok(keys.length >= 20);
  for (const key of keys) { assert.ok(messages.it[key]); assert.ok(messages.en[key]); }
});

test('passkey login validates email only, reuses session loading, and restores controls after errors', async () => {
  const controls = [{ disabled: false }, { disabled: false }], calls = [];
  let valid = false, failure = false, reported;
  const form = { dataset: {}, isConnected: true, elements: { email: { value: ' user@example.invalid ', reportValidity: () => valid } }, querySelectorAll: () => controls };
  const context = createContext({ $: () => form, api: {}, accountLock: async run => run(),
    runPasskey: async (_api, kind, input) => { calls.push([kind, input]); if (failure) throw new Error('passkeyCancelled'); },
    forgetActive: async () => calls.push('forget'), clearSession: () => calls.push('clear'),
    accountChannel: { postMessage: value => calls.push(value) }, loadData: async () => calls.push('load'), syncQueue: async () => calls.push('sync'),
    passkeyFormError: (_form, error) => { reported = error.message; } });
  runInContext(section('async function passkeyLogin(', 'async function showPasskeySecurity()'), context);
  await runInContext('passkeyLogin(false)', context);
  assert.deepEqual(calls, []);
  valid = true;
  await runInContext('passkeyLogin(false)', context);
  assert.equal(calls[0][0], 'login');
  assert.equal(calls[0][1].email, 'user@example.invalid');
  assert.deepEqual(calls.slice(1), ['forget', 'clear', 'changed', 'load', 'sync']);
  calls.length = 0; valid = false; failure = true;
  await runInContext('passkeyLogin(true)', context);
  assert.equal(calls[0][1].discoverable, true);
  assert.equal(reported, 'passkeyCancelled');
  assert.ok(controls.every(control => !control.disabled));
  assert.equal(form.dataset.saving, undefined);
});

test('management submits rename/delete/register, confirms deletion, and displays server conflicts', async () => {
  let handler, action = 'rename', confirmed = true, failure = false, errorShown, reloads = 0;
  const calls = [], controls = [{ disabled: false }];
  const panel = { dataset: {}, isConnected: true, querySelectorAll: () => controls };
  const form = { dataset: { passkeyAction: action, id: 'synthetic-id' }, elements: { name: { value: ' Updated ' } }, closest: () => panel };
  const context = createContext({ document: { addEventListener: (_event, callback) => { handler = callback; } },
    confirm: () => confirmed, t: key => messages.en[key], modalVersion: 1, session: { user: { id: 'synthetic-user' } },
    api: { renameCredential: async (...args) => calls.push(['rename', ...args]), deleteCredential: async id => { if (failure) throw Object.assign(new Error('Synthetic conflict'), { code: 'LAST_CREDENTIAL' }); calls.push(['delete', id]); } },
    runPasskey: async (_api, kind) => calls.push([kind]), showPasskeySecurity: async () => reloads++,
    passkeyFormError: (_form, error) => { errorShown = error.code; } });
  runInContext(section('async function submitPasskeyForm(event) {', 'function showSettingsForm()'), context);
  const event = { target: form, preventDefault() {} };
  await context.submitPasskeyForm(event);
  assert.deepEqual(calls[0], ['rename', 'synthetic-id', 'Updated']);
  form.dataset.passkeyAction = 'delete'; confirmed = false; await context.submitPasskeyForm(event);
  assert.equal(calls.length, 1);
  confirmed = true; failure = true; await context.submitPasskeyForm(event);
  assert.equal(errorShown, 'LAST_CREDENTIAL'); assert.equal(reloads, 1);
  assert.equal(controls[0].disabled, false);
  failure = false; await context.submitPasskeyForm(event);
  assert.deepEqual(calls[1], ['delete', 'synthetic-id']);
  form.dataset.passkeyAction = 'register'; await context.submitPasskeyForm(event);
  assert.deepEqual(calls[2], ['register']); assert.equal(reloads, 3);
});
