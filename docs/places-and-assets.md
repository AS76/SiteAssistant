# Specification of places and installed assets

Proposal for SiteAssistant, verified on `origin/main` at commit `3313f4e`. The future behaviour described in the following sections requires implementation and approval. Observations on current behaviour report references to the checkout.

## 1. Problem and use cases

Today a task belongs to a site and has an optional free-text field `area`. Creation reads the text and the list displays it directly (`server/migrations/pg/001_init.sql:11–24`, `server/repository.mjs:360–369`, `app/app.mjs:585`). The text alone does not identify a room, nor does it allow reliable retrieval of all evidence about the same component.

The scenarios below describe site and plant practices. They are illustrative, without data or records from SiteAssistant.

| Context | Operation and expected outcome |
| --- | --- |
| Site | During the finishing walk-round, a fire door is found not to close. The defect, photo and corrective task can be retrieved from the room. If the door is registered, it can also be reached from its record card. |
| Plant | During the acceptance test of an air handling unit, the technician links the record and nameplate photo to the unit. The path shows the plant room and distinguishes it from a room with the same name in another building. |
| Maintenance | A recirculation pump is replaced. The maintainer retrieves the serial number and warranty of the new pump and consults previous interventions under the old pump. |
| Handover | For the handover of a floor, the manager collects the asset list, manuals, records and open defects. Once the handover is issued, the dossier version is retained even if room names change. |

## 2. Place model

- The existing site is the root. Each place has an immutable UUID, `site_id`, a reference to its parent, a type, a name, a status and creation and modification metadata. The place UUID remains stable even if the path changes. A null parent indicates a direct child of the site.
- Ordinary path: `site → building → floor → zone → room`. Proposal for sites without a building and floors without zones: intermediate levels may be omitted while respecting the order of types. For example, an external zone directly under the site and a room directly under a floor are admitted. A node has exactly one parent and always belongs to the same site.
- Current path and inclusion in subtree filters derive from the ancestors. Attachments, warranty data and module permissions remain associated with the entities that own them. A parent node does not automatically assign a place to its children's records. Historical records also retain the path recorded at the relevant time.
- Renaming changes the label. Moving changes the parent of the entire subtree, with checks on types and ancestors. Both operations record author, timestamp and previous values. Assets and linked records keep their UUIDs. An asset's physical position changes only through an explicit movement. An update across sites is rejected.
- Ordinary removal is logical archiving. Work from the leaves towards the root: block archiving when there are active children, or planned or installed assets whose current position is in the node. With only documentary or historical references, allow archiving and keep the node viewable with a visible status. The selector for new links excludes archived nodes. The ordinary API offers no physical deletion. Any administrative correction procedures may delete only records with no children, references or history.
- Client codes and exports use explicit aliases `site_id + namespace + canonical code → place_id`. The namespace identifies the authority or source and, where needed, the scope of the catalogue. Retain the original code, source and validity. Prevent double assignment of the canonical code within the same namespace and site, including after archiving. A corrected code leaves a trace of the previous alias. Never derive identity from name or path. The case-sensitivity policy for codes is agreed per source.

## 3. Installed asset register

| Field | Proposed rule |
| --- | --- |
| Minimum | Immutable UUID, site, tag, name, category, status and creation/modification metadata. Tag unique within the site among active or planned assets. Current position mandatory at installation, optional when planned. |
| Technical identification | Serial number, manufacturer, model, plant system, external references. Serial number required only for categories approved by the owner. Explicit absent value. The serial number alone does not identify the asset. |
| Operational dates | Installation, acceptance test and commissioning dates kept distinct. Record the actual date of transition to installed status. |
| Warranty | Supplier or guarantor, reference, start and end dates, conditions and document. Dates optional, with end equal to or later than start when known. No implied expiry in the absence of contractual data. |
| Documents | References to versions of manuals, declarations, records, as-built drawings and warranty evidence. Document metadata kept separate from the attachment bytes. |

Proposed transitions: planned → installed → replaced or decommissioned. A cancelled planned asset may be decommissioned with a reason. A replacement closes the position of the old asset and links its UUID to that of the new one, which has its own identity and warranty. If the tag designates the functional position, the successor may inherit it in the same transaction after the predecessor is closed. The previous tag remains visible in history. Terminal states remain viewable, with administrative corrections tracked.

Each position has `site_id`, `asset_id`, `place_id`, start and end of validity, author, reason and recorded path. Intervals do not overlap and at most one is open. A physical transfer closes and opens intervals in the same transaction. A place may contain multiple assets. For the first release, each installed asset has only one current place.

The proposed register has an identity separate from `hse_assets`. Today that table manages HSE items of types `tool`, `site_work` and `ppe`, with inspection templates. The HSE inspection requires their ID. An explicit reference to the installed asset may be added for equipment that appears in both registers (`server/migrations/sqlite/029_hse_assets.sql:1–16`, `server/migrations/sqlite/030_hse_inspections.sql:1–16`).

## 4. Links with modules

Use module-typed keys with `site_id` and the UUID of the record, place and asset as needed. References must be verifiable, with constraints that include the site. Where a place and an asset appear together, the record's place describes the evidence at the time of the fact. The asset's place valid on that date may be proposed, subject to confirmation. A different place is admitted if it is explicit, for example for a photo taken in the workshop before installation. For read-only or archived references, keep the resolved IDs visible with label and status, in addition to the recorded path. Aggregate views apply the permissions of the originating module.

| Module | Verified starting point | Proposed key | Removal and migration |
| --- | --- | --- | --- |
| Tasks | Text `tasks.area`. The current PATCH accepts only `wbsId` (`server/migrations/sqlite/001_init.sql:11–24`, `server/http.mjs:992–1008`, `server/repository.mjs:276–285`). | One primary location and an optional asset for `task_id`. | Show the archived context, including for a closed task. Backfill with an approved map of `area`, retaining the text. No asset inference from the title. |
| Defects | No dedicated defect register found. Deviations are a projection with `plc_area` and their own links (`server/migrations/sqlite/011_deviations.sql:1–23`, `server/http.mjs:867–904`). | `defect_id` with mandatory place and optional asset, once the module exists. Possible separate link to `deviation_id`. | Retain archived place and asset on the record card. No automatic conversion of deviations into defects. If deviations are integrated, resolve `plc_area` with the source map into a separate local relation. |
| Photos and attachments | Images and PDFs associated with `entity_type/entity_id`. The site is derived from the owner, with role and module checks (`server/repository.mjs:680–681`, `server/repository.mjs:693–728`, `server/migrations/pg/038_identity_evidence.sql:15`). | `attachment_id` with optional place and asset, keeping the owner and access controls. | Archiving the context does not delete the file. For existing attachments, navigation is possible from the placed owner, indicating the provenance of the context. No copying, EXIF analysis or bulk assignment of location. |
| Inspections | The HSE inspection has a mandatory `asset_id` pointing to `hse_assets`. Creation checks the site and status of the HSE item (`server/migrations/pg/030_hse_inspections.sql:1–16`, `server/hse-inspections.mjs:60–65`, `server/hse-inspections.mjs:105–131`). | `inspection_id` with optional inspection place and installed asset. The mandatory reference to the HSE item remains for the existing flow. | Keep the inspection context after decommissioning. Link history only with explicit confirmation of the match and of the position on the inspection date. |
| Documents | The existing path handles PDFs as attachments (`server/repository.mjs:712–728`, `server/http.mjs:906–928`). No versioned document register found. | `document_version_id` linkable to multiple places or assets. The version identifies the attachment with its metadata. | The version and its references remain viewable. Classify existing PDFs only on confirmation. A version already delivered requires protection from deletion of the attachment. |
| Handover | The diary has text fields and a day/shift key. No dedicated handover dossier found (`server/migrations/sqlite/001_init.sql:37–48`, `server/seed-demo.mjs:584–598` for the synthetic examples in the notes only). | `handover_revision_id` with a scope of places, asset list, document versions and evidence references. On release, freeze the list and the path of each item. | Issued revisions remain readable with archived references. No backfill from the diary, descriptions or file names. The first revision arises from explicit selection. |

## 5. Migration and rollback

1. Carry out a read-only inventory, per site, of the distinct values of `tasks.area`, with counts, nulls, empty strings and variants. Where an extension to deviations is approved, inventory separately per site and source: the import already projects `plc_area` as `area_code` (`server/planning-import.mjs:84–90`, `server/planning-import.mjs:115–124`). Keep the value available in the database exactly as it is, with a reference to the record. Distinguish the persisted data from the original value of any source file.
2. Propose candidates with conservative normalisation for comparison: Unicode NFC, leading and trailing spaces removed, sequences of spaces reduced, and case-insensitive comparison where appropriate. Keep punctuation, leading zeros and accents. Apply external codes only under the rule agreed for the source. The search key serves to group candidates and does not assign an identity.
3. Have the site manager approve the hierarchy and the map per site and source, with versioned rules and record-level exceptions. A description such as “P1”, a room with the same name in several buildings, or a value indicating several zones remains to be resolved. No automatic splitting on separators. If detail is missing, it is acceptable to map at the confirmed level. Nulls and blanks remain without a place. If a reused input changes meaning, do not reapply the rule without verifying its validity and context.
4. Add a compatible model and links to both databases through a future pair of migrations. Keep the API and the `area` column compatible with existing clients. Activate per site after a preview of candidates, confirmed and unresolved items. Apply in idempotent batches, with a log of source, value, rule, decision, actor and resulting UUIDs. Do not overwrite manually entered locations or values changed after the preview. Measure preserved records and values, coverage, unresolved items and conflicts.
5. Operational rollback: disable new writes and reads of the model for the site, leaving the legacy views on `area` active. To cancel a batch, detach only the links it created that are still identical to the recorded result. Isolate conflicts and retain nodes, assets, movements and references produced after activation. Verify counts before reactivating. Avoid destructive schema rollback while clients coexist.

The loader records the executed versions in `schema_migrations` (`server/migrations/index.mjs:69–79`). The number of the future migration is to be chosen by the implementation branch. The base observed here already contains migrations up to 055 in both dialects (`server/migrations/sqlite/055_demo_seed_environment.sql:1`, `server/migrations/pg/055_demo_seed_environment.sql:1`). The state of a PostgreSQL environment is checked with the maximum of `app.schema_migrations.version` in that environment.

## 6. API and interface

Proposed contracts. The prefix is `/api/sites/:siteId`, and `:id` is a UUID of the indicated site. Operations with an effect on history are transactional. Use a revision to reject writes on superseded data, and idempotency keys for creations or retryable events.

| Method | Relative path | Purpose |
| --- | --- | --- |
| GET, POST | `/places` | Read the tree, search by name or code, filter by parent and status. Create a node. |
| GET, PATCH | `/places/:id` | Read the record card and path. Rename and manage aliases. |
| POST | `/places/:id/moves`, `/places/:id/archive` | Move a subtree or archive, with reason and checks. |
| GET, POST | `/assets` | Search by tag, serial number, status and subtree. Register an asset. |
| GET, PATCH | `/assets/:id` | Read the record card and edit metadata, including warranty. |
| GET, POST | `/assets/:id/positions` | Read history or record a transfer. |
| POST | `/assets/:id/transitions` | Install, replace with a successor or decommission, with date and reason. |
| GET | `/places/:id/history`, `/assets/:id/history` | View tracked changes to a place or asset. |
| GET, PUT, DELETE | `/tasks/:id/location`, `/attachments/:id/location`, `/hse-inspections/:id/location` | Read, set and unlink place and asset within the scope of the record. Track the unlinking. For tasks, also extend the existing creation with optional references. |
| GET, POST | `/place-mappings` | View candidates and unresolved items. Approve a version of the map. |
| POST | `/place-backfills`, `/place-backfills/:id/rollback` | Preview or apply an approved batch. Controlled cancellation of the batch. |
| GET, POST, PATCH | `/defects` for list and creation, `/defects/:id` for detail and edit | Future contract for the defects module, with place and asset on the record card. |
| GET, POST | `/documents`, `/documents/:id/versions` | Future contract for the register and its versions. |
| GET, PUT | `/documents/:id/versions/:versionId/links` | Read or update the set of links of a version, with a new version when already delivered. |
| GET, POST | `/handovers`, `/handovers/:id/revisions` | Future contract for dossiers and revisions. |
| POST | `/handovers/:id/revisions/:revisionId/issue` | Issue and freeze a revision. |

Minimal screens:

- **Place selector** with search by name and code, full path for same-named items, optional choice of asset, and the legacy value visible when the map is missing. Usable by keyboard and on mobile.
- **Place tree** with expansion, breadcrumbs, filters by type and status, actions according to role, and a summary of dependencies before a move or archive. Include a reconciliation view with batch preview.
- **Asset record card** with tag, serial number, position, status, warranty, documents and position history. Show references to records of the accessible modules.
- Labels and messages in Italian and English. In the first release, manage master records and reconciliation online. The task queue already exists (`app/app.mjs:378–384`, `app/offline.mjs:166–194`). The legacy replay with only `area` remains valid. For any queued IDs, revalidate site and status on replay, and show the conflict without losing the content of the request.

## 7. Permissions and demo environments

Today site roles pass through `accessible_site_members`. The general editing roles include `owner`, `editor` and `demo_user`, while verification roles include `owner`, `verifier` and `demo_user` (`server/repository.mjs:90–101`). The view excludes `demo_user` from ordinary accounts and limits sandbox accounts to sandbox sites with a role other than owner (`server/migrations/sqlite/051_demo_user.sql:44–48`). Sandbox-mode signup approval assigns `demo_user` on sites marked as sandbox (`server/signup.mjs:62–70`).

| Role | Proposed rule |
| --- | --- |
| Owner | Creates, renames, moves and archives places, manages aliases, approves and cancels backfills. Performs all operations on the site's assets. |
| Editor | Creates assets, updates data, installs, records transfers, replacements and decommissionings. Links records in modules for which it has write rights. |
| Verifier and viewer | View the site's master records and the visible references. Verification operations continue to follow the rules of the respective module. |
| Demo user | Simulates place and asset operations on synthetic data, only with permitted sandbox accounts and sites. No administrative actions on the shared backfill. |

Check role, site membership and module permissions on the server at every request. The cross-cutting record card also filters search results, counts and downloads. Retain the audit of mutations, links and backfill actions. Agree with the owner which shared sandbox sites should enable move and archive operations. The demo uses synthetic catalogues and files, in line with existing guidance (`README.md:66–68`).

## 8. Acceptance criteria and negative tests

| Test | Verifiable outcome |
| --- | --- |
| Rename and move | UUIDs and links remain unchanged. Filters use the new path. The dossier already issued and the historical evidence show the recorded path. |
| Cycle | Moving a place under itself or under one of its descendants returns `409`. Even two concurrent, incompatible moves cannot leave a cycle. |
| Cross-site parents or assets | A parent, place or asset from another site produces `422` for a conflict between visible references, or `404` when the reference is not accessible. No partial mutation. |
| Deletion with references | Physical removal of a referenced place or asset is rejected. Archiving a place occupied by an active asset, or with active children, returns `409`. With only historical references, archiving keeps the place viewable and the node disappears from selectors. |
| Duplicate code | Two identical canonical aliases in the same site and namespace produce `409`, even with concurrent requests. The same value in different namespaces is admitted. Two active assets with the same tag in the site produce `409`. |
| Asset lifecycle | Installation without place and interval, warranty with inverted dates, or an invalid transition is rejected. A transfer leaves only one open interval. Replacement preserves the predecessor's documents and serial number. |
| Migration and rollback | Nulls, blanks and variants remain recoverable. Ambiguous same-named items remain unresolved. Repeating the batch generates zero duplicates. Cancellation preserves later manual changes and the records created during adoption. |
| Compatibility | A pre-existing client creates and displays the task with `area`. A repeated replay with the same key does not duplicate the task. HSE checks and attachment access continue to work with the original references. |
| Permissions | A viewer cannot make mutations. A demo user cannot write on ordinary sites. A user without access to the originating module gets no files, results or counts by indirect routes. |

Run the constraint and concurrency cases on both SQLite and PostgreSQL. Serialise tree mutations per site within the same transaction that checks for cycles. Also protect movements, archiving and issued revisions from concurrent writes. SQLite already enables foreign key checking (`server/db.mjs:16`).

## 9. Risks, out of scope and owner decisions

| Risk | Planned control |
| --- | --- |
| Wrong map or reused codes | Preview, confirmation and provenance for every link. Retention of the original value. |
| Confusion between current position and position at the time of the fact | Explicit intervals, historical path and perimeter frozen at handover. |
| Data exposure from cross-cutting views | Site and module controls also applied to counts, documents and attachments. |
| Growth of the tree and differences between dialects | Indexes per site, parent and references; checks in the API and equivalent constraints in the two databases. |
| Confusion between HSE item, functional position and installed asset | Distinct identifiers and explicit correspondences with history. |

Out of scope for the first release: BIM/GIS and geometries, synchronisation or modification of source systems, maintenance planning and spare parts, digital signature, automation of warranty deadlines, transfers between sites, and automatic classification of photos.

Decisions to approve with the owner:

1. Confirm omissible levels, a single primary position, and coverage of external areas, linear works and works spanning several zones.
2. Establish code authority, rules for namespaces and case, the tag recycling policy, and the categories with mandatory serial number.
3. Name who approves the map per site, and define the operational threshold for unresolved items before activation.
4. Decide whether to release the tree, register, tasks and attachments first, and when to fund defects, documents and handover. Decide the scope of the integrations with deviations and HSE.
5. Approve editor and demo user permissions, audit depth, dossier retention and the contractual constraints on warranty.

## 10. Implementation status (27 November 2026)

This section distinguishes what is in production from what remains a proposal. The previous sections describe the complete model and should be read as a specification, not as a report.

**Delivered**

- Increment 2a (`4b99bf2`): place tree with breadcrumbs and filters, reusable place selector, routes `GET`/`PATCH` `/api/places/:id`, `POST /api/places/:id/moves`, `/archive`, `GET /api/places/:id/history`, transactional move with cycle rejection, and archive with dependency check.
- Increment 2b (`0264c98`): `GET /api/assets/:id` with current position, warranty and history count; `GET /api/assets/:id/positions`; filters `tag`, `serial`, `status` and `placeId` as subtree on `GET /api/assets`; operational view with search, record card, history and role-based actions.

**Not yet implemented**

- Predecessor→successor link in replacement: today `replaced` is only a terminal state. It requires an additive migration.
- Route `POST /api/assets/:id/transitions`: transitions use the existing routes `PATCH /api/assets/:id`, `POST /api/assets/:id/move` and `POST /api/assets/:id/archive`.
- `GET /api/assets/:id/history` as a dedicated list of tracked changes: the audit exists, the route does not.
- Links with tasks, attachments and HSE inspections (`/tasks/:id/location` and similar), typed place aliases, maps and backfills.
