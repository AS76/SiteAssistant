// Native WebAuthn boundary. Server challenge identifiers never enter browser options.
export const supportsPasskeys = (env = globalThis) => Boolean(env.isSecureContext && env.PublicKeyCredential && env.navigator?.credentials?.create && env.navigator?.credentials?.get);
export function fromBase64url(value) {
  const base = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base.padEnd(Math.ceil(base.length / 4) * 4, '=')), c => c.charCodeAt(0));
}
export function toBase64url(value) {
  const bytes = new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength);
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function browserOptions({ challenge_id, ...options }) {
  const result = { ...options, challenge: fromBase64url(options.challenge) };
  if (options.user) result.user = { ...options.user, id: fromBase64url(options.user.id) };
  for (const key of ['allowCredentials', 'excludeCredentials']) {
    if (options[key]) result[key] = options[key].map(item => ({ ...item, id: fromBase64url(item.id) }));
  }
  return result;
}
export function credentialJSON(credential) {
  if (!credential) throw new Error('passkeyCancelled');
  const response = {};
  for (const key of ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle']) {
    if (credential.response[key] != null) response[key] = toBase64url(credential.response[key]);
  }
  if (credential.response.getTransports) response.transports = credential.response.getTransports();
  return { id: credential.id, rawId: toBase64url(credential.rawId), type: credential.type,
    response, clientExtensionResults: credential.getClientExtensionResults(),
    ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}) };
}
export async function runPasskey(api, kind, input = {}, env = globalThis) {
  if (!supportsPasskeys(env)) throw new Error('passkeyUnsupported');
  const registration = kind === 'register';
  const options = await (registration ? api.passkeyRegisterOptions() : api.passkeyLoginOptions(input));
  let credential;
  try {
    credential = await env.navigator.credentials[registration ? 'create' : 'get']({ publicKey: browserOptions(options) });
  } catch (error) {
    if (['NotAllowedError', 'AbortError'].includes(error.name)) throw new Error('passkeyCancelled');
    if (error.name === 'InvalidStateError') throw new Error('passkeyAlreadyRegistered');
    throw new Error('passkeyBrowserError');
  }
  const envelope = { challenge_id: options.challenge_id, response: credentialJSON(credential) };
  return registration ? api.passkeyRegisterVerify(envelope) : api.passkeyLoginVerify(envelope);
}
