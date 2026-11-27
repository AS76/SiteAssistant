# Specification of people, companies and crews

Status: proposal for approval. The references to the code describe the base `8d717cb`. The rules for the new flows are proposed requirements. The assumptions to be validated are in §9.

## 1. Real problem and use cases

The task requires the text names of the executor and the verifier, and may have their respective account IDs. When present, the IDs must belong to active members of the site with compatible roles. A free-text name avoids creating an account for an external operator, but leaves their identity unresolved across different records. The acceptance flow uses the account ID of the designated verifier, with an exception for the owner. (`server/repository.mjs:360–412`, `server/repository.mjs:505–514`)

- A subcontractor receives a link to photograph an intervention. It can send images and propose a status for the indicated record. The internal manager assesses the contribution, and the authorised verifier decides the outcome.
- An external inspector carries out a site inspection. An internal operator records the inspector as the material author, with the company they belonged to on the inspection date. The account that records the outcome remains tracked.
- A supplier delivers materials. The order identifies the company, and the delivery may indicate the contact person present. A photo from outside, if requested, documents the delivery and remains subject to internal confirmation.
- A crew changes leader during the work. The new leader appears on new assignments from the effective date. Earlier reports continue to show who led the crew at the time of the fact.

## 2. Model of person, company and crew

Follow the principles of [places and assets](places-and-assets.md#2-place-model). Use immutable UUIDs, references bound to the site, logical archiving and change history. The minimal model assumes registers per site. A link between sites would require a future explicit decision.

| Entity | Proposed data and constraints |
| --- | --- |
| Person | UUID, site, display name, optional name components, optional operational contacts, optional language IT/EN, status and metadata. The name and contacts may change or be shared. Use them only as reconciliation clues. |
| Company | UUID, site, registered name, optional tax identifiers with jurisdiction, type, original value and canonical value. Roles towards the site, for example contractor, subcontractor, inspection body or supplier, with time validity. Apply uniqueness to confirmed identifiers according to rules approved per jurisdiction, keeping historical aliases. |
| Affiliation | Person and company of the same site, declared relationship, validity interval and source. Several relationships may coexist. Whoever records the fact indicates the relevant one. |
| Crew and membership | Crew with UUID, name and optional lead company. Membership with person, crew, operational role and validity interval. A change of leader closes the previous mandate and opens the new one in the same transaction. In the minimal model, leader intervals for the same crew do not overlap. |
| Account link | Explicit, optional and tracked relationship between a person of the site and an account. At most one active link per person and one per account within the same site. Owner confirmation and verification of active site membership for a new link. |

Use intervals with start inclusive and end exclusive. Record author, instant, reason and previous values. Import aliases qualify the key with the site and namespace of the source, keeping the original value and validity. Correcting a key preserves history and prevents an alias already assigned from being silently reused. Relationships between records include the site in the reference keys.

An authorised operator selects or records a person even without an email, and links them to a participation with role, date, optional company or crew, and source. The fact keeps the UUID and the label recorded at the time. The audit identifies separately the account that records the fact. A contribution via link instead identifies the link, the declared recipient if any, and the acquisition channel. Possession of the link does not prove the identity of the person using it.

## 3. Operational roles and application permissions

| Operational role | Registrable participation |
| --- | --- |
| Executor | Person assigned to carry out the work, with an optional reference crew and company. |
| Verifier | Person designated for the check, distinct from the executor. A documented external check may be acquired as evidence. |
| Crew lead | Person responsible for the crew for an interval. The dated assignment remains viewable after replacement. |
| Inspector | Person carrying out the inspection, with an optional company and declared qualification. |
| Supplier | Company supplying goods or services, with an optional person as contact or delivery officer. |

The application roles remain `owner`, `editor`, `verifier`, `viewer` and `demo_user`. The server reads the role from the accessible membership, and the modules apply their own checks, including `workforce_names` for named HR access. (`server/repository.mjs:90–102`, `server/hr.mjs:40–59`, `server/migrations/pg/051_demo_user.sql:4–6`)

At the minimum proposed, the owner curates master records, account links, reconciliation and archiving. The editor may select persons and companies and record their participation where they have write access. The verifier uses the verification actions provided by the module and the existing designation conditions. The viewer consults only the projections permitted by their modules. The demo_user operates within the demo perimeter with synthetic data, with external flows disabled in the initial release. Searches by assignment expose only operational labels and relevant affiliations. Access to HR data and access to contact details remain explicit controls.

Operational designation does not confer a membership. For reserved actions, check account, site, module, role and any applicable designation. If the operational verifier has no account, their check may be acquired as evidence, and the owner may exercise the power of acceptance already provided for. Separation between executor and verifier is also checked when one is indicated via a linked account and the other via the person's UUID. A person without an account may appear in the records, have their work recorded by an internal operator, and send contributions expressly authorised by the link.

## 4. Lightweight external access

The link grants access to one site and to a single explicitly shared object: a task, a photo request linked to a record, or a punch list publication with selected items. Before issuance, the operator sees exactly the shared content, the authorised actions and the expiry. The recipient sees a public title, the instructions, the current public status and the relevant published items. They may upload photos and propose a status, or mark an item as ready for check, only if authorised. These contributions enter an internal queue with a tracked outcome. Closure, verification, reopening and updates of the official status remain in the authenticated flow.

The external response uses an explicit list of fields. Diary, HR, contacts, members, prices, complete orders, internal notes, restricted HSE outcomes, other records and pre-existing attachments remain outside that list. No general search or list of the site, including counts and suggestions. The link does not create an account, a membership or an application session. The current invitations have their own consumption flow, with site and role, documented in `server/invitations.mjs:76–79` and `server/invitations.mjs:166–183`.

- **Secret and expiry.** Opaque token generated with at least 256 random bits. Store only its digest. Use HTTPS and exchange the token for a separate credential, limited to the same link and with remaining duration at most equal to that of the link. Proposal: token in the URL fragment, redemption via POST from the dedicated page, and removal of the fragment from the current history. Dedicated cookie `HttpOnly`, `Secure`, `SameSite`, bound to the external surface. Origin check and CSRF defence for writes. No token in request URLs, logs, referrers or telemetry. Page without third-party scripts, and responses with `Cache-Control: no-store`, excluded from the PWA cache.
- **Scope and revocation.** On every request, verify the server-side absolute expiry, revocation, site, type and object ID, the list of items and the granted action. Reject even a target that is no longer shareable. Revocation takes effect also on credentials already issued. Serialise revocation with the publication of the contribution, and recheck the scope before commit after an upload. Widening the scope requires a new explicit issuance.
- **Abuse and responses.** Limit attempts per network origin, including with unknown tokens, and, for a valid link, frequency and cumulative volume per link and site. Apply limits before accepting files, and coordinate quotas across instances. Respond with the same `404`, a generic body and behaviour comparable to an absent, unknown, expired, revoked, wrong-site or out-of-scope token or object. Return `429` with a wait for rate limits, without indicating whether the link is valid. A valid capability on the requested target with a reserved action receives `403`.
- **Photos and recording.** Accept approved raster formats, validate the actual content, limit size and number, remove sensitive metadata from previews, and keep uploads private until validated. Keep the original according to the approved policy. Each submission has an idempotency key per link and target. Storage errors or revocation during submission leave the photo unavailable and the attempt tracked, with cleanup of unreferenced objects. Record issuance, revocation, access attempts, reads and submissions with instant, outcome, internal link ID, site and target when resolved, and the issuing account or the person responsible for revocation. Logs are restricted-access and subject to limited retention. Exclude secrets, files and contribution text from the access log.

## 5. Links with existing modules

Participations and attributions use module-typed references, with site, record ID and role. Cross-cutting views respect the permissions of the source module, including for searches, counts and downloads. Where applicable, evidence keeps references to place and asset according to the [relevant specification](places-and-assets.md#4-links-with-modules).

| Module | Verified current status and proposed integration |
| --- | --- |
| Tasks | Keep optional names and account IDs (`server/repository.mjs:364–412`). Add operational executor and verifier, optional company or crew, and an assignment snapshot. The designated account remains the authorisation reference. Record reassignments and account changes explicitly. |
| Defects and punch list | No dedicated module found in the base examined. Deviations have their own flow (`server/http.mjs:867–904`). When the defects module exists, add reporter, the person assigned to the fix, and verifier, with specific permissions. A punch list publication shares only the selected items. No automatic conversion from deviations. |
| Inspections | `performed_by` and `performer_role` are texts with internal or external mode. Saving requires HSE access (`server/hse-inspections.mjs:88–112`, `server/hse-inspections.mjs:125–132`). Link inspector and company with a snapshot at the date. Recording and outcome remain in the HSE module. |
| Procurement | The order stores `supplier_name` in plain text (`server/purchase-orders.mjs:166–189`). Shipment links to lines verify the relation with the order (`server/shipments.mjs:163–167`). Link the supplying company to the order and, at delivery, the explicit contact, if any. Preserve the name on the order and keep contact, carrier and supplier distinct. |
| Staff and import | HR promotion generates employee IDs from site and employee number, and replaces the selected projection with its working days (`server/hr.mjs:146–206`). Keep a local reconciliation to person, company and crew. Imported records, days and their permissions continue to follow the HR flow. |
| Attachments | Today the server resolves the site from the owning entity, checks role and module, and removes the storage reference from public metadata (`server/repository.mjs:679–709`, `server/repository.mjs:732–758`). Reuse private storage and keep the owning entity. After approval, associate the ordinary attachment with the record and keep the external provenance, without simulating the author as an internal account. |

Archiving excludes the person, company or crew from new assignments and closes the active relations relevant from the effective date, keeping UUIDs, snapshots and closed intervals viewable. Before archiving, show the open tasks, relations and links concerned. Require explicit reassignment for current assignments indispensable to complete a task, or block archiving with `409`. Reassignment does not rewrite facts already recorded. Revoke in the same operation the active links issued for the archived recipient or for a participation being closed. An archived company does not automatically archive its affiliated persons. Accounts and memberships follow their normal authorisation cycle. No ordinary physical deletion, nor cascade to tasks, orders, inspections or files.

## 6. Migration, reconciliation and rollback

1. Inventory per site the records with account IDs, the texts without IDs, the `employees` rows and their sources. Keep original texts, nulls, IDs, source metadata, history and attachments. Keep the fields and APIs already in use compatible. Identify separately each free-text occurrence with site, record, field and source revision.
2. In future, add the schema in a pair of additive migrations for SQLite and PostgreSQL. Keep local links and aliases outside the replaceable projection. The presence of a migration in the repository does not attest its application in any environment.
3. Generate a preview without writes. Use existing account IDs as evidence of the historical link to the record. For HR, use source and employee number only if the namespace is confirmed and the code is stable within that perimeter. A reused employee number, a deactivated account, homonyms, similar company names, multiple candidates or the absence of IDs require an explicit decision. A coinciding name generates only a suggestion. A historical account may remain visible on the record without creating an active link.
4. The authorised reviewer confirms a link, creates a new record, or leaves the occurrence unresolved with a reason. Unresolved cases show the source text. Save for each choice the source, value, rule, actor, source revision and resulting UUID. No links between sites. Apply transactional, idempotent and resumable batches. Reject decisions on revisions changed since the preview, and preserve manual changes. Compare coverage, unresolved items, conflicts and historical values before and after each batch.
5. Activate per site after a verification on synthetic data and batch approval. Subsequent HR promotions keep the confirmed reconciliation and flag identity changes or disappearances. Disappearance from the projection does not archive the person. Preserve evidence according to the applicable retention policy, keeping in the migration register only the references and values needed.
6. For rollback, disable the new flows and revoke the site's links, restoring compatible reading of the legacy fields. Cancel only the links created by the batch and still at the applied revision, with a compensating event. Flag conflicts and new dependencies for manual correction. Preserve the decision register, originals, new writes and attachments. IDs already referenced remain resolvable. Also test restarting the migration after rollback.

## 7. API and minimal screens

Proposed contracts. For internal APIs the prefix is `/api/sites/:siteId`. Every operation checks membership, role and module. Use revision for concurrent mutations, and idempotency for retryable operations.

| Contract | Operation |
| --- | --- |
| `GET/POST /people`, `/companies`, `/teams` | Paginated search by label, and creation. Expose contacts and tax identifiers only to authorised profiles. |
| `GET/PATCH /people/:id`, `/companies/:id`, `/teams/:id`; `POST /<register>/:id/archive` | Detail, update and archiving with reason and dependencies. Dated writes for affiliations, memberships and account links. |
| Module mutations | Add optional operational IDs and return the recorded label and archive status. Keep the textual fields and application permissions compatible. |
| `POST /people-reconciliation/previews`, `POST /people-reconciliation/batches` | Preview, approval of decisions and tracked application. Batch consultation and compensating rollback are available to the owner. |
| `GET/POST /external-links`, `POST /external-links/:id/revoke` | Internal list with metadata, issuance returning the secret once only, and revocation. |
| `GET /external-contributions`, `POST /external-contributions/:id/review` | Internal queue filtered by module and review, with outcome and reason. |
| `POST /api/external/redeem`, `GET /api/external/sites/:siteId/shared/:id`, `POST /api/external/sites/:siteId/shared/:id/contributions` | Redemption, published projection and submission of contributions. The external credential identifies the link, and the ID indicates the shared object. The client does not choose the owning entity or the author of the attachment. |

Minimal screens: a filterable register and record cards with history and dependencies; a selector in tasks and in the enabled modules, with labels for archived references; a reconciliation queue with the original shown alongside; a sharing panel with preview, expiry and revocation; a mobile IT/EN page for viewing and submission; an internal queue to accept or reject contributions. The punch list is enabled when its module has stable IDs, permissions and selective publication.

## 8. Acceptance criteria and negative tests

| Scenario | Verifiable outcome |
| --- | --- |
| Person without account | An authorised editor records them as a participant. No new account or membership. The audit distinguishes participant and authenticated operator. |
| Same person through different references | A designation as executor via account and as verifier via the linked person is rejected, without writes. |
| Crew leader change | Intervals are contiguous at the effective date. Earlier and later reports show the correct references. A concurrent change does not create two active leaders. |
| Valid link | The recipient sees only the published fields and submits an authorised photo. Repeating the same request produces a single contribution. The official status remains unchanged until the internal flow. |
| Expiry and revocation | On reaching expiry, or after revocation, redemption, reads and writes return the same `404` as for an unknown link, even with a cookie already issued. |
| Link to another site or item | Replacing site, object or item in the request yields `404`, with no metadata, effects, file URLs or indication of the record's existence. |
| Reserved action without account | A verification requested on the external surface with a valid capability returns `403`. The external cookie sent alone to ordinary APIs does not authenticate the user. Domain status and audit do not report any verification performed. |
| Invalid photo and limits | Declared type and content that disagree are rejected. Beyond the threshold, the service returns `429` for frequency. Quotas and sizes block the write before publication. No failed object is viewable. |
| Revocation during upload | If revocation precedes the commit of the contribution, no photo is published and storage is cleaned up. The log keeps the outcome without any token. |
| Archived person or company | A historical task keeps the ID and label, with archived status visible. Selectors and new assignments exclude the record. An indispensable operational dependency requires reassignment, or produces `409`. |
| Ambiguous import, repetition and rollback | Homonyms and recycled employee numbers remain unresolved, with the original text visible. A second application does not duplicate links. Rollback preserves fields, attachments and manual corrections, and leaves the audit viewable. |
| Cross-cutting permissions | A profile without `workforce_names` does not retrieve named HR rows, days or restricted aggregates through the register, search or export. The test also applies to demo_user. |

During implementation, run the site, constraint, concurrency and rollback tests on both databases. Verify in the browser the external page, revocation after redemption, and the absence of restricted content from the offline cache.

## 9. Risks, out of scope and owner decisions

The main risks are incorrect attributions after an import, spread by forwarding of links, acquisition of sensitive photos, indirect exposure of HR data, and loss of historical context following a reassignment. The preview with confirmation, the explicit scope, the duration limits and the snapshots address these risks. A forwarded link can be used by whoever receives it until expiry or revocation.

Out of scope: global master records across sites, write synchronisation towards source systems, replacement of the HR projection, identity verification, signature or legal attestation, automatic onboarding of accounts, and conversion of deviations into defects.

| Decision to approve | Assumption for the minimum |
| --- | --- |
| Who issues and revokes links | Only the site owner for launch. Consider explicit, revocable delegation to editors with a dedicated permission and an enabled module. The owner may revoke any link on the site. Confirm automatic revocation when the issuer loses sharing rights. Until approval, the flow remains disabled. |
| Duration, reuse and distribution | Proposal of 24 hours by default and a maximum of 72 hours, reducible per site. No implicit renewal. A link may serve several contributions within quota. First submission made manually by the issuer. Confirm whether some cases require single redemption or a second factor. |
| External publication | Confirm fields, proposed statuses and admitted modules, who validates submissions, and conditions for sharing delivery or inspection evidence. Photos and task status as the first phase. Punch list subject to the dedicated module. |
| Data protection and thresholds | Approve access to contacts and tax identifiers, logged events, retention periods, any network data, limits per file and per link, and rules for originals and metadata. |
| Identity and reconciliation | Confirm the register per site, reliable sources, rules for tax canonicalisation, the scope of the employee number, handling of duplicates, and uniqueness of the crew leader. Approve reviewers and criteria for activation and rollback per site. |
