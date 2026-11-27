# Specification of the site diary and evidence

Status: proposal for approval. The code verification refers to the base `8d717cb`. The rules described as requirements are proposals. The operational assumptions to be confirmed are in §10.

## 1. Problem and use cases

The diary records plan, actuals, impediments and next step in one entry per site, operating day and shift. The server records the time of entry, the site's time zone and cutoff, and the ID of the author account when available. It accepts retrospective entries, with role rules and a reason beyond seven days. Corrections archive the previous snapshot, the account making the correction, the instant and the reason, then update the current row. The client can view the versions. The current schema and actions of the diary do not provide for a material author distinct from the account, the time of the fact, a declared language, the structured sections of §2, closure or signature. (`server/migrations/sqlite/001_init.sql:37–48`, `server/migrations/sqlite/045_diary_versions.sql:1–16`, `server/repository.mjs:546–555`, `server/repository.mjs:573–676`, `server/http.mjs:1030–1036`)

| Case | Evidence that must be reconstructable |
| --- | --- |
| Dispute over a service order | Text received or reference to the revision of the document, instruction actually communicated, sender, recipients, declared times and distinct confirmations. |
| Weather suspension | Source and time of observations, zone and works affected, start and resumption if known, decision and person responsible, original photos and observations pointing the other way. |
| Defence against a compensation claim | Chronology of facts, impediments, resources present and communications, with sources, versions and visible gaps. The export also retains the relevant corrections. |
| Handover with reservations | Scope, participants, record and revision, defects or specific reservations, and available evidence; link to the later resolution of the reservation without altering the original record. |

## 2. Entry model

First proposed adoption: keep the record per site, operating day and shift. A record may describe several facts, each with its own stable identifier, material author, role and time where these differ. Each entry has a stable UUID, and each published revision has its own UUID and sequential number. Every new fact, grouping or link retains its provenance.

| Data | In draft | At closure |
| --- | --- | --- |
| Scope and status | Site, operating day, shift, IANA time zone and cutoff applied, initial status draft. | Freeze the recorded values; validate consistency between the time of the fact, operating day and shift. |
| Attribution | The authenticated account that records is automatic. The material person and operational role may be provisional. | Material author of the entry or identified source, operational role at the time of the fact and its company if relevant. Retain UUIDs and label snapshots. Indicate who observed, who reported and who transcribed, where these differ. |
| Times | Keep the time declared by the device, if local, and assign the server recording time at the first successful save. Time of the fact optional. | For each fact, use a time or interval with start inclusive and end exclusive, source, offset and precision; or declare the time unknown, with a reason and the precision available. Retain server receipt and recording, distinct from the time of the fact and local time. |
| Language and content | Language declared by the author, IT or EN, and at least one content item or photo capture. Texts may be incomplete. | Confirm language and the actuals summary. Plan, impediments and next step must have text, or an explicit outcome with a reason where the data is missing. Preserve the original language of quotations and attachments. |
| Weather and resources | Optional sections. | Complete each relevant section, or state “none”, “not applicable” or “not recorded” as appropriate. Weather with source, time, unit and impact. Labour with crew or company, quantity and period, without named HR detail by default. Equipment with type or asset, quantity, use and period. |
| Deliveries, visitors, instructions | Optional rows and provisional references. | For relevant rows, state fact, time and source, company or person as needed, document and revision if available. For instructions, record sender, recipients and channel. For deliveries, record outcome and reservations. Explicitly indicate absence, inapplicability or data not recorded. |
| Places, tasks and evidence | Resolvable references or references to reconcile, with local photos awaiting clearly indicated. | Relevant place, or a reason for a general site entry. Applicable operational references with resolved status or a declared gap. Photos follow §4. |

For intervals that span a shift, state the continuous fact in the text and link the relevant entries without duplicating the evidence. Keep historical texts, nulls, accounts, reasons, dates and attachments of earlier entries as legacy history. Show missing fields as not recorded. A retrospective designation requires a source and an explicit act. No closure or signature is attributed automatically to legacy data.

## 3. Lifecycle and corrections

- **Draft.** The editor enabled for the diary creates or edits their own or assigned drafts. The owner may act on the site's drafts. Each save updates the concurrency revision and records the account and instant.
- **Closed.** The owner, or an editor with explicit delegation valid for the site, closes online after the checks in §2 and §4. In a single operation the server checks permissions, the expected revision and file availability; records the closure and the author of the act; and freezes content, references, metadata and the file index via the digest of a canonical snapshot. From that point the content of the revision is immutable.
- **Signed.** The owner, or the verifier expressly designated and authorised for the entry with access to the diary, confirms online after re-authentication. In the proposed profile, the signatory is distinct from the person who closed. The explicit act associates account, person, role, server instant, authentication method and the digest of the closed revision. Recording the act and the transition to signed are atomic. The initial signature is an application-level attestation, subject to the decision in §10. Signature, closure and archiving produce traceable events.
- **Correction.** An authorised editor or the owner opens a new draft from the published revision, with a reason and a reference to the original and to the previous revision. The new version follows the same cycle, with its own signature. Until the correction is signed, the last signed version keeps its evidence and the correction is visible as pending. If no version is signed, distinguish the last closed one from the draft in progress. Block direct updates to frozen content, including by the owner and via attachments. Keep versions, reasons and signatures viewable in order.
- **Concurrency.** Closure, signature and publication of a correction check the expected revision and are serialised per entry. Logical archiving with a reason, and access to history, follow the site's permissions. Removal from an operational view does not change the snapshot, digest or signatures.

## 4. Photo archive

Current attachments have an owning entity, upload metadata and SHA-256. The server also verifies the bytes read back from storage, and there is a deletion path. The current contract for diary attachments links them to the entry, without an evidence index by place, time of capture or task. (`server/repository.mjs:679–709`, `server/repository.mjs:750–804`, `server/repository.mjs:834–849`, `server/http.mjs:906–935`)

Each photo in the new archive has an evidence UUID, a private original with hash and size, a revision of the entry, and a place in the same site. Link the task where relevant, or state its inapplicability with a reason. Authorised search filters by place and descendants, date of the fact or capture, and task, flagging the origin of the time filter. Show the historical path at the date of the fact. Store the caption, source and author of the capture if declared, declared time and offset, EXIF data if available and relevant, time of receipt, validated type and provenance. Show any divergence between times. If the capture date is unknown, record the gap explicitly and make the photo retrievable via the entry date. GPS position is optional and subject to the approved policy. Derivatives and previews have their own ID and may omit sensitive metadata. The original keeps the bytes acquired.

A temporary upload without a valid link remains in staging and outside the archive. A pending, unreadable, missing or wrong-digest file blocks closure if declared as available evidence. Before closure, it can be retried, or the reference can be converted into an explicit gap with a reason and the approval of the person responsible for closure. A contractual requirement for mandatory evidence, if configured, continues to block closure. A later loss is reported with an availability event, the recovery outcome and an incomplete status in the export. The original digest and reference remain unchanged. A restoration counts as the original only if the bytes match the digest.

Download expiry, logical archiving and the retention period are distinct. When an authorised link expires, the original follows its own policy and remains accessible to authorised users. A dispute suspends disposal according to §10. Acquired photos follow the retention of the entry and of the dossiers that reference them, with any longer approved constraints. No ordinary physical deletion. The cleanup of uncaptured temporary uploads, after the approved recovery window, is separate from the disposal of evidence.

## 5. Offline and reconciliation

The current queue includes diary creation, task creation and transitions, and attachment uploads, including resolution of the local ID of the entity. It can merge diary creations that have never been sent. On replay it checks the session, retains the day and shift of a deferred write, and handles uncertain outcomes. Diary corrections and inspection creation call the API directly. (`app/offline.mjs:6–7`, `app/offline.mjs:82–88`, `app/offline.mjs:158–209`, `app/app.mjs:2867`, `app/app.mjs:4425–4449`)

Without a network, a user already authenticated, with cache and space available, can create and edit a local draft and capture original photos with declared metadata, using references already available or marked for reconciliation. The interface indicates local save, pending, conflict and confirmed outcome. It reports exhausted quota and loss of persistence without showing a save confirmation. Closure, signature, export, acquisition of permissions and inspection writes require a network. Lightweight external access remains online.

When the network returns:

1. Check the current account, site and permissions. Isolate drafts and blobs per account and site, including on shared devices. Suspend the replay if the session changes or access is revoked.
2. Send the entry and references first, then the photos and their links. Use stable client UUIDs and server-side persistent idempotency keys per operation, site and account. The same key and the same content return the same outcome, including after a timeout. The same key with different content produces a conflict. The file hash helps diagnosis, with identical captures admitted in distinct contexts.
3. In case of a slot occupied by another UUID, a superseded revision or an already closed entry, preserve the local copy and the photo index. Show the differences, and merge the contributions into a compatible draft or into an explicit correction, after the authorised user's choice. The resolved operation has a new key and uses the updated revision. An uncertain outcome is reconciled through the original key.
4. Save the raw value, offset, declared time zone, precision, provenance and server receipt time. Use the site's time zone and cutoff to determine the operating day, requiring an explicit offset for ambiguous local times. Compare the declared time of the fact with the server time and an approved, configurable tolerance. Beyond that threshold, reject the official mutation and preserve the local copy for a reasoned correction. Keep the original declaration and the reason. Also flag late entries according to the site's policy.

Offline, the device or EXIF time is a declaration. The first server acknowledgement attests when it received the content associated with the digest, within the reliability of the server clock. An independent time proof requires an approved source or service, with a reference kept in the dossier.

## 6. Exportable evidence package

The existing export produces a CSV with tasks, deviations and attachment metadata, with a paired checksum. The dossier proposed here adds entries, versions, originals and attestation events. (`server/evidence-export.mjs:24–62`, `server/http.mjs:943–963`)

- **Scope.** Generate a ZIP from the site, a period with end exclusive, and an explicit selection of entries. Freeze the dossier ID, the server generation instant, scope, filters, included versions and coverage. The official dossier contains closed and signed revisions, the chain of corrections, roles, attributions, reasons, times with sources, references and authorised originals. Declare the status, gaps and limitations of the selection without revealing restricted records. If a mandatory dependency for the requested dossier is missing, block full issuance and allow only a result declared incomplete within authorised limits.
- **Formats.** Include a UTF-8 JSON index with the format version and the published rules of canonical serialisation, a readable PDF statement, the original files in the formats acquired, and a separate checksum of the index. The export indicates references to documents and revisions, and includes authorised copies where the scope provides for them. The two presentations are Italian `it-IT` and British English `en-GB` (UK). Identifiers, machine values, times with offset and original texts remain identical. Any translations are labelled and associated with the original text.
- **Integrity.** The index lists unique paths, type, size, the SHA-256 of each file's bytes, snapshot digests and the status of missing evidence. It indicates the closure and signature events and the digest of the revision to which each signature refers. Recalculate the digests of the originals at export. Make the index digest available to the recipient through a trusted channel distinct from the delivered file, or a verifiable signature of the index if approved. Keep in the audit the dossier ID, digest, author, instant and scope of the issuance.
- **Independent verification.** Provide instructions to verify the index checksum, recalculate the file digests, detect missing, added or altered items, follow the chain of versions, and compare the attested digest with the snapshot. Indicate which times and identities are declared, which are attested by the app, and which are supported by external proof. A trusted digest allows verifying the integrity of the corresponding package. The authenticity of any cryptographic signatures requires approved material and verification rules. The content remains a record with sources and any gaps.

## 7. Links with other registers

Apply the [specification of places and assets](places-and-assets.md) and the proposal for people and companies, `docs/people-and-companies.md` at revision `7a9b038`, as project dependencies. Use stable UUIDs, a site-scoped perimeter, logical archiving, validity with start inclusive and end exclusive, and no ordinary physical deletion. A revision snapshot keeps the ID, label, path, role and sources relevant at the date of the fact. Renames, moves, changes of affiliation and archiving leave historical links readable. Links without a stable ID require explicit reconciliation, keeping the original value.

| Register | Proposed relationship |
| --- | --- |
| Places, assets and tasks | Link the precise place of the fact or capture, any asset in its valid position at that time, and the tasks concerned. A general place requires a scope reason. |
| People and companies | Link the material author, the persons involved and the relevant affiliations. The account records the application action. Avoid deducing identity from homonyms, contacts or HR data. |
| Inspections | Reference the HSE record and its revision, if available. The diary may attest that the inspection took place. The outcome and HSE attachments follow the permissions and flow of the source module. |
| Defects and documents | Where the registers allow, link defect, reservation and document via ID and historical revision. For a document acquired as evidence, keep the digest. For a future register or an unresolved reference, keep the declared source. An existing deviation remains a distinct typed link. |

## 8. Permissions and demo environment

The existing diary applies membership, role and module access in write operations and in reads of history. The `demo_user` role is already provided for, and its assignment is restricted to the sandbox. (`server/repository.mjs:90–102`, `server/repository.mjs:129–135`, `server/repository.mjs:573–593`, `server/repository.mjs:622–675`, `server/admin.mjs:56–65`)

| Actor | Proposed scope |
| --- | --- |
| Owner | Views site history, administers delegations and archiving, closes and signs under the conditions of §3, and generates dossiers within the permissions on the data included. |
| Editor | Views permitted entries, drafts, attaches files and proposes corrections within the assignment. Closes with explicit delegation. |
| Verifier | Views permitted revisions, and signs the closed one if designated. |
| Viewer | Views permitted closed or signed revisions. Downloads and exports require the respective authorisations. |
| Demo user | In the authorised sandbox only, views synthetic data and simulates drafts, photos, closure, signature and export in the prepared cases. Attestations, PDFs and the index carry the simulated nature. No access to ordinary sites and no issuance of external links. |
| Lightweight external access | Sees only the photo request or the object already shared, according to the people and companies specification. May submit contributions if authorised. The contribution is approved internally with explicit provenance. No consultation of the diary, pre-existing originals or the dossier, nor closure or signature. |

Apply server-side checks to every request, including history, previews, search by place, counts, PDFs and downloads. Verify the permissions of the source module also in cross-cutting views, and omit restricted identifiers and attributes. Delivery to third parties is an explicit issuance of the authorised dossier, with audit of the recipient and the scope. Named HR access and contact details require the relevant permissions.

## 9. Acceptance criteria and negative tests

| Test | Verifiable outcome |
| --- | --- |
| Signature after closure | Signature on a draft fails. After closure, the authorised signatory, distinct from the person who closed, may sign only the expected digest. Signature with a superseded revision or revoked permissions fails without a partial event. |
| Correction of a signed version | A direct update, including of metadata or attachments, is rejected. A reasoned correction creates another revision UUID, goes through closure and signature, and leaves the digests, signature and files of the previous version verifiable. |
| Orphan photo | A photo with a missing entry, or from another site, stays out of the archive, searches and export. A photo expected but absent blocks closure, unless an approved gap is admitted. Loss after signature produces an incomplete dossier with the original digest preserved. |
| Entry with future time | With a controlled server clock, a fact beyond tolerance is rejected and remains editable in the local copy. An ambiguous time without an offset requires explicitation. A deferred recording preserves the distinct times. |
| Offline conflict | Two clients start from the same revision and one closes before the other's replay. The second receives a conflict, keeps text and photos, and can propose a correction. A replay with the same key after loss of the response produces a single record and a single link per operation. |
| Dossier integrity | The recipient detects a changed byte, a removed or added file, and a misaligned version. The IT/UK change preserves original texts, references and snapshot digests. A later rename of a place or company leaves the already issued dossier unchanged. |
| Permissions and legacy data | A viewer does not write. A user without HSE permission gets no information from links, search or export. A demo user and an external link do not leave their respective scope. A legacy record keeps its fields and history, without identity or signatures added ex officio. |

Verify concurrency and invariants on the two supported databases. Test the mobile path with disconnection, reload, timeout on replay and exhausted storage, checking the messages and the visibility of the originals.

## 10. Risks, out of scope and owner decisions

| Risk | Control or decision |
| --- | --- |
| Application signature interpreted as a legally valid digital signature | The owner defines with the legal referent the jurisdictions, required value, document categories, method, any provider and long-term verification requirements. Any use of certificates, time stamps, revocation data and renewal of proofs requires a decision before the intended formal use. |
| Loss of evidence or excessive retention | Approve duration and start for data, originals, dossiers, audit and backups; responsibility and procedure for recovery; holds for litigation; mandatory exceptions; and any authorised disposal. Test restoration and digest checks. No duration can be deduced from the code. |
| Weak attribution and disputed time | Approve admissible sources, the hourly tolerance limit, rules for late entries and the applicable time zone. Establish when to request external confirmation or a time stamp. |
| Exposed resources and personal information | Approve named fields, GPS, display, delegations, issuance to third parties and dossier minimisation. Agree sandbox access and the duration of local data on shared devices. |
| Operational constraints too rigid | Confirm granularity per shift, separation between closure and signature, handling of replacements, mandatory sections per event type, and exceptions for missing evidence. Establish the release order of dependencies and the adoption of earlier records. |

Per-shift granularity, online signature with two distinct actors, the `en-GB` presentation and the possibility of declaring gaps are design assumptions. The availability of the referenced registers depends on the release of the linked specifications.

Out of scope initially: digital signature with certificates or trust services, offline signature, offline changes to inspections, automatic acquisition from sensors or weather services, automatic classification of photos, recognition of persons, release of the defects module, and write synchronisation with source systems.
