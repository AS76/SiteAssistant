# Passkey backend API

This backend requires `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN`. The additive
035 SQL files are migration definitions, not evidence of an activated service.

`POST /api/auth/webauthn/register/options` requires a real session and an empty
JSON object. `POST /api/auth/webauthn/login/options` is public and accepts either
`{ "email": "user@example.invalid" }` or `{ "discoverable": true }`.
Both return browser options plus a server-generated `challenge_id`.

The client must retain `challenge_id` separately from the browser options.
The browser credential response does **not** contain this identifier. Send the
serialized browser response to the corresponding `/register/verify` or
`/login/verify` endpoint in this explicit JSON envelope:

```json
{ "challenge_id": "returned challenge UUID", "response": { "id": "credential ID", "response": {} } }
```

The abbreviated response above illustrates the envelope only; the real response
must include all fields required by the WebAuthn verifier. Missing identifiers
return 400. Challenges expire after five minutes and are consumed before
cryptographic verification; expired, replayed, or failed verification returns 401.
Registration verification requires the same real user session. Login verification
is public and sets a session cookie only after successful verification. All
routes use the API rate limiter; login options and verification also use the
login attempt limiter before invoking the passkey backend.

`GET /api/auth/credentials` returns the current user's credential metadata, with
`transports` as a JSON array and no public key. `PATCH /api/auth/credentials/:id`
accepts `{ "name": "My passkey" }`; `DELETE` refuses the last credential (409)
and revokes sessions associated with a successfully removed credential.

`auth_events` is append-only, including across account deletion. Its nullable
`user_id` deliberately has no foreign key: anonymous failures use NULL, and
historical user identifiers survive account deletion without mutating events.
Public keys are stored as binary BLOB/BYTEA; transports are stored as serialized
JSON text and decoded at the API and verifier boundaries.
