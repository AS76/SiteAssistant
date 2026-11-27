# Privacy notice states, validation and publication gate

Status: PROPOSED — implemented by the accompanying increment, pending legal review of the text itself.
Scope: how SiteAssistant decides whether a privacy or cookie notice may be shown, and in what form.

## The problem this solves

A notice rendered from configuration can be in three very different conditions, and the software
currently distinguishes only two: configured and not configured (`server/privacy.mjs`, `configured`).
A configuration that is technically complete — controller name, address, contact, legal bases — would be
published as if it were final. It is not: completeness is not approval.

The distinction is not cosmetic. A notice that looks final but has never been reviewed is worse than an
honest "not yet available", because it tells users something the operator has not actually verified.

## Three states

The configuration carries an explicit state. Absence of the field means `example`: silence never
publishes anything.

| State | Meaning | HTTP | Rendered |
| --- | --- | --- | --- |
| `example` | Sample or incomplete configuration. Not a notice. | 503 | "Notices not configured" page, listing which required fields are missing (names only, never values) |
| `pending-legal-review` | Complete per Article 13, not yet approved by the controller. | 200 + `X-Robots-Tag: noindex` | Full notice, with a persistent banner: pending legal review, not a final notice |
| `approved` | Complete and explicitly approved by the controller. | 200 | Full notice, with version and update date |

`approved` additionally requires `approvedBy`, `approvedAt` and `reviewRef` (the reference of the legal
review that backed the approval). A state without them falls back to `pending-legal-review`, never to
`approved`.

## Required fields (Article 13 checklist)

A notice is *complete* only when every item below is present. The validation reports the **names** of the
missing items, never their values, so an incomplete page cannot leak configuration content.

- controller: name and a contactable address, or the documented alternative chosen by the operator;
- privacy contact: a syntactically valid address, not on a reserved domain (`example`, `invalid`,
  `localhost`) once the state is above `example`;
- purposes: at least one, each with its legal basis;
- legal bases: at least one, non-empty;
- recipients and processors: each service with name, purpose, role, location;
- transfers outside the EEA: declared per service, including "none declared" as an explicit value;
- retention: each category with a period and a basis;
- rights: the data subject rights section present;
- complaint authority: present;
- version and `updatedAt`.

Placeholder detection is structural, not textual: the check verifies presence, type and plausibility of
each field. Reserved domains are rejected because they cannot receive mail, not because of the word used.

## Self-hosted installations

`PRIVACY_CONFIG_FILE` already allows an operator to point at a configuration outside the repository.
That stays the mechanism: no new module, no parallel system.

The repository keeps a synthetic example only. The public demo's real configuration lives outside the
source tree, injected at deploy time, so the controller's personal data is never committed. A self-hosted
installation inherits nothing from the demo: if it does not provide its own configuration, its state is
`example` and it publishes no notice.

## What this does not do

- It does not make a notice legally correct. Approval is a human act, recorded in `approvedBy`,
  `approvedAt` and `reviewRef`.
- It does not decide whether a consent banner is needed. Today no non-essential storage is in use; if
  that changes, consent needs its own design, with prior blocking and withdrawal.
- It does not replace the review of the text. It only stops unreviewed text from being presented as final.

## Tests

- state resolution: absent state means `example`; `approved` without approval metadata degrades to
  `pending-legal-review`;
- missing-field reporting: names listed, no values echoed;
- reserved-domain contact rejected above `example`;
- `pending-legal-review` renders the banner and sets `X-Robots-Tag: noindex`;
- `approved` renders version and update date, no banner;
- Italian and English are generated from the same configuration and expose the same sections;
- no personal data of the demo controller appears in any committed file.
