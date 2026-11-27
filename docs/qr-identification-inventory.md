# QR identification, label printing and physical inventory

Proposal for SiteAssistant, verified against `origin/main` at commit `0e44e3c`. The future behaviour described here requires implementation and approval. Observations about the current state refer to the checkout. Reference card: *QR Identification & Inventory* on the internal Workboard.

This specification arises from an operational need that emerged with InsiteLMS: on site and in the warehouse, the physical label is how an object is found again, not a graphic accessory. The specification does **not** authorise implementation and does **not** anticipate the Places and Assets 2a and 2b increments, which remain priority and unchanged.

The product decisions were approved by the owner on 27/11/2026 and are incorporated in full in the text; what remains open is listed in §14.

## 1. Problem and use cases

Today an installed asset is found by searching by tag, an item of equipment by name or code, a supply item by scrolling through order lines. This works as long as you are in front of a screen. On site the object is in front of you and the screen is not: manual search introduces typing errors, homonyms and, during checks, disputes that are hard to close.

The scenarios below are illustrative, with no data or records from SiteAssistant.

| Context | Operation and expected result |
| --- | --- |
| Acceptance test | The technician scans the label on the electrical panel and reaches the asset record, with location, warranty and history. Nothing is typed. |
| Material delivery | On arrival of the pallet, the crew leader scans the parcel label and sees which order it belongs to and what has already been received. |
| Equipment | The supervisor takes charge of a hammer drill: the scan opens the equipment and proposes a usage record, not a generic form. |
| HSE check | The inspector scans the asset and reaches the record, where the history of HSE checks is a chapter of the asset, not a parallel register. |
| Inventory | At the end of the site work, areas are walked through scanning labels in sequence. The system reports what has not been seen, what has been seen twice and what is in an area other than the expected one. |
| Handover | The handover dossier cites assets by stable identifier, not by name: renaming a room or an item does not break the references. |

## 2. Verified product state

None of this functionality exists today. The useful foundations, however, are in `main`.

| Element | Verified state | Reference |
| --- | --- | --- |
| Installed assets | Table `assets` with UUID `id`, `site_id`, `tag`, status `planned/installed/replaced/decommissioned`, serial number, warranty. Tag unique within the site **only among non-archived records**. | `server/migrations/sqlite/057_places_assets.sql` |
| Positions | `asset_positions` with half-open intervals, one open interval per asset, `recorded_path` frozen. | `057_places_assets.sql` |
| Places | `places` with UUID, `site_id`, parent, type `building/floor/zone/room`, logical archiving. **No aliases**: neither table nor column. | `057_places_assets.sql`; `server/places.mjs:84-102` |
| Equipment | Table `tools` with UUID `id`, `name`, `code`, `company`, status, **`location` as free text**. | `server/migrations/sqlite/018_tools.sql` |
| HSE assets | `hse_assets` with `kind` `tool/site_work/ppe`, `code`, and optional `tool_id` referring to `tools`. | `server/migrations/sqlite/029_hse_assets.sql` |
| Materials | **No master record.** Only `material_no` as text on `purchase_order_items` and `package_items`. | `032_purchase_orders.sql`, `033_packages.sql` |
| Shipments | `shipments`, `shipment_packages`, `shipment_receipts` with quantities received per order line. | `034_shipments.sql` |
| Exposed APIs | `GET/POST /api/places` and `GET/POST /api/assets`. The detail, `moves`, `positions` and `transitions` routes are missing: they are the subject of 2a and 2b. | `server/http.mjs:541-550` |
| Attachments | `attachmentTables` covers `task`, `diary`, `site`, `hse_event`, `hse_inspection`, `deviation`. It does **not** cover `asset` or `place`. | `server/repository.mjs:680-681` |
| Access modules | `MODULES` in `server/module-access.mjs:4-7`. There is no module for identification, places or assets: today access depends only on the site role. | `server/module-access.mjs` |
| Runtime dependencies | Only `pg` and `@simplewebauthn/server`. No QR, barcode, PDF or printing library. | `package.json` |
| Offline queue | Types `create_task`, `transition_task`, `create_diary`, `create_attachment`. No inventory operation. | `app/offline.mjs:6` |
| Idempotency | `Idempotency-Key` header already accepted by the HTTP gateway. | `server/http.mjs:238` |

Direct consequence: the QR functionality can be designed and, for assets and equipment, implemented as soon as 2a and 2b are in `main`. Identification of **materials**, on the other hand, depends on the Site Materials & Inventory module, specified separately in `docs/site-materials-inventory.md`.

## 3. Object identity

### 3.1 Single identity rule

A single physical object has **one** permanent identity and **only one** canonical QR identifier. Two registers may describe the same object, but they cannot each own an identity.

| Domain | Authoritative register | Role of the other registers | QR identity |
| --- | --- | --- | --- |
| Equipment and tools | **`tools` (018)** | `hse_assets` manages checks, fitness and safety information, without duplicating the identity; the link already exists as `hse_assets.tool_id` | On the UUID of `tools` |
| Installed assets | **`assets` (057)** | If an asset is subject to HSE checks, the HSE asset refers to the asset and manages its controls, without a new identity | On the UUID of `assets` |
| Items and materials | **`stock_items` / instances** of the Site Materials & Inventory module (not yet existing) | `purchase_order_items` and `package_items` remain document lines, not master records | On the UUID of the item or instance |
| HSE assets with no counterpart | **`hse_assets`** | — | On the UUID of `hse_assets` |

Operational consequences:

- The label is applied to the authoritative register. If the same drill appears in `tools` and in `hse_assets`, the single label carries the UUID of `tools`; the HSE record is reached from the equipment record, not from a second label.
- Extending the principle to installed assets requires that `hse_assets` can refer to an `asset_id`, symmetrically to what already happens with `tool_id`. This is a schema change, hence a **dedicated increment approved by the owner on 27/11/2026**, not a side effect of this specification.
- Until that change exists, an asset with HSE checks can only be registered as a separate HSE asset: the risk of a double label is real and must be managed with an explicit operational rule (the owner indicates which of the two is authoritative for the site in progress), not ignored.

### 3.2 Shared mechanism, no universal master record

What is shared is **only the identification layer**: a payload, a resolution, a scanning behaviour. No central register of labels and no universal object table is introduced.

- The identification layer creates no record in any master record and does not duplicate name, description or location: the QR points to a record that lives in the owning module.
- The entity type is typed (`asset`, `tool`, `hse_asset`, in future `stock_item`, `material_instance`). Keys and controls follow the approach already proposed for module links in `docs/places-and-assets.md` §4: `site_id` plus UUID, with constraints that include the site.
- Adding an entity type is an extension of the list, not the creation of a master record.

### 3.3 Reconciliation of unlinked HSE assets

`tools` remains the authoritative register of equipment. However, there are still records in `hse_assets` with a null `tool_id`, created before the link existed or from different flows. **Owner decision (27/11/2026): explicit reconciliation with verification of physical identity, no association inferred from name or description.**

| Step | Rule |
| --- | --- |
| 1. Candidates | The system proposes possible matches by similarity of name, code or category, **as a suggestion to be verified**, never as a decision |
| 2. Physical verification | Whoever reconciles confirms the identity of the object: nameplate, serial number, location, visual check. Name similarity is not proof |
| 3. Link | `hse_assets.tool_id` is set to the equipment, with author, timestamp and rationale |
| 4. No merge | The two records are neither merged nor deleted: the HSE asset keeps its history of checks, the equipment keeps its identity |
| 5. Label | Before reconciliation an unlinked HSE asset may have its own label; after reconciliation there remains **one authoritative label** and the second is withdrawn, not reassigned |
| 6. Explicit rejection | If the physical check does not confirm the match, the proposal is closed as rejected and remains traced |

An automatic association based on names or descriptions is excluded: two identical drills of the same model are two objects, and only the plate or the serial number says so.

## 4. Permanent identifier

### 4.1 Canonical payload

The payload is a versioned, readable and self-contained URN:

```
urn:siteassistant:entity:1:<uuid>
```

| Owner requirement | How it is met |
| --- | --- |
| Permanent and versioned identifier | The version number sits in the payload: a future version 2 remains distinguishable without a central register or migration of labels already printed. |
| Independent of the tag | The payload does not contain the tag, which is unique only among active records and is therefore reusable after decommissioning. |
| Independent of location | No path, no `place_id`, no location text. Moving does not invalidate the label. |
| Independent of hosting domain | No URL. The same label works on the Railway demo, on a self-hosted instance and locally. |
| No sensitive data | Only an opaque identifier: no name, serial number, personal data, token, signature or signed URL with expiry. |

The UUID identifies the **physical object**, not the register that describes it at a given moment. A material instance and the installed asset it turns into share the same physical identifier: see §4.6. It is this choice, and not an implementation detail, that allows a label printed on receipt to remain valid after installation.

### 4.2 The label is not a key

An identifier is enumerable: whoever photographs a label knows the UUID. It is not a secret and must not be treated as authorisation. Resolution checks on every request: authentication, site membership, role and permission of the owning module. A QR read by someone without access produces `404`, not a message that reveals the existence of the record.

### 4.3 Typable short code

The QR may be unreadable: scratched, faded, badly printed. A typable fallback is needed that **does not** suffer from tag recycling.

**Owner decision (27/11/2026):** a 26-character code derived from the UUID is not ergonomic enough. The UUID remains the canonical identifier **inside** the QR; under the QR a **permanent short code** is printed, with a check character and no reassignment. The final length is to be validated during implementation.

| Option | How it works | Assessment |
| --- | --- | --- |
| **Short code per entity (approved)** | Dedicated column on the entity, generated at creation, restricted alphabet, check character, unique within the site, never reassigned | Ergonomic on site, requires a migration for each master record and an exhaustion policy |
| Code derived from the UUID (rejected) | Crockford base32, 26 characters | **Rejected by the owner**: too long to type |
| Code = tag (excluded) | The existing tag | **Excluded**: the tag is recycled and the label would become false |

Rules for the short code:

- **Restricted alphabet** without ambiguous characters: Crockford base32 excluding `I`, `L`, `O`, `U`. The code can be read and dictated without confusing `0`/`O` or `1`/`I`/`L`.
- **Check character** mandatory (algorithm to be chosen during implementation: Damm or prime modulus). It serves to reject a typo **before** querying the server, and to distinguish "I mistyped" from "it does not exist".
- **Provisional length 6 data characters plus 1 check character** (7 in total), printed in two groups (`A7K2-9F` + check). Higher values only if field testing requires it. The definitive number is an implementation decision, validated on a real mobile keyboard.
- **Uniqueness and collisions**: unique constraint `(site_id, entity_type, short_code)`. Generation tries a random code and, on collision, retries up to a limit of attempts; when that limit is exceeded the criterion changes (greater length), never reassignment. A collision is an expected event, not an error to be ignored.
- **No reassignment**: a code belongs to the entity forever, even after archiving or decommissioning. An old code may become inert, it may not become false.
- **Exhaustion**: with 6 characters on a restricted alphabet the space per site is large but not infinite. Occupancy is monitored and the code is lengthened for new entities; labels already printed remain valid because the length is recognisable from the code itself.
- **Resolution within the site scope**: the code is resolved within the selected site, never globally, and it is never an authorisation.

The short code is an addition to the identifier, not a substitute for it: the QR continues to contain the URN with the UUID from §4.1.

### 4.4 Labels with direct URL — future option

Approved as a future option, **not** in the first release. A label with a URL (`https://<domain>/e/<uuid>`) is more convenient to scan with the system camera, but it ties the physical object to a domain: if hosting changes or one moves from demo to production, the printed labels stop working. It is admissible only for deployments with a stable, declared domain, and it must be issued as an explicit variant, never as the default format. The canonical payload remains the one in §4.1.

### 4.5 Resolution and edge cases

- **Not found**: valid payload but the record does not exist, is archived or was deleted. The interface shows "identifier not recognised" and never reassigns the UUID.
- **Different site**: `404` response, as for an inaccessible record. No disclosure of existence or name.
- **Malformed payload**: unknown version or invalid UUID. `422` with a neutral message, no creative interpretation.
- **Never reused**: a UUID is never reassigned to a new object. An old label may become inert, it may not become false.
- **No register**: a label register understood as a second master record would be a duplicate. Instead the **print event** (§5.6) is recorded, which is genuinely needed, plus the short code which is an attribute of the entity and not a separate register.

### 4.6 Continuity of physical identity between receipt and installation

A serialised instance received on site receives a label. Months later the same instance is installed and becomes an asset. **The label is not reprinted and two identities are not created.**

How this is achieved:

1. **One identifier per physical object, from birth.** The material instance (`stock_instances`, see `docs/site-materials-inventory.md` §3.2) is born with its own UUID and its own short code. The label printed on receipt carries that UUID.
2. **Installation does not create a new identity: it links.** The transition to installed asset produces the record in `assets` with its own asset UUID, and `stock_instances.asset_id` records the link. Resolution of the label follows the link and opens the record that is currently relevant.
3. **Resolution chooses the register, not the identity.** The same payload may point to an instance in stock or to an installed asset depending on status: the response declares the current type and, when a link exists, also the other reachable register. The payload does not change and no reprint is needed.
4. **The short code remains that of the instance.** If the asset has its own short code, both remain valid and are linked; the interface shows the other identifier on the record, so whoever holds the old label still finds the right record.
5. **Explicit prohibition.** No resolution may infer identity from serial number, name or description: the instance→asset link is an explicit act, traced and reversible only by another traced act.

Consequence for printing: whoever prints on receipt does not need to know whether the object will be installed. The label is correct in both cases, which is exactly why the payload does not contain an immutable entity type but a server-resolved identifier.

## 5. Labels and printing

### 5.1 Three formats

| Format | Content | Use | Dependency |
| --- | --- | --- | --- |
| **Compact** | QR and readable identifier | Small objects, durable labels, inventory | None |
| **Descriptive** | QR, tag, designation, model, serial number and other configurable data | Panels, equipment, parcels, dossiers | None |
| **Logistic** | Item, quantity, lot, parcel, destination | Receipt, handling, warehouse inventory | **Subordinate** to the Site Materials & Inventory module |

Common rules:

- The fields of the descriptive format are configurable per site and per entity type; the default set is QR, tag, designation, model, serial number.
- Variable information — location, supplier, current location — is **optional** and, when included, accompanied by the **print date** and the wording that the data are those of that date.
- The compact format contains nothing that can become false: only the identifier, which by construction does not change.
- The logistic format cannot exist before the item master: without item and lot there would be nothing to print that is not already on the order line, and printing it would be misleading.

### 5.2 Printing: single, bulk, reprint, preview

- **Single**: from the entity record.
- **Bulk**: from an explicit selection (search results, subtree of places, order lines). Never "the whole site" without confirmation with a count.
- **Preview** mandatory for bulk printing: how many labels, which formats, which entities lack a typable code.
- **Reprint**: repeatable from the print history, with an optional reason. Repeating a print does not duplicate records.
- **Customisable dimensions**: width, height, margins, grid pitch and QR module, with profiles saved per site.

### 5.3 A4 sheets

Grid layout on A4 with configurable margins and pitch, to fit commercial adhesive label sheets. Server-side composition (SVG embedded in HTML) and printing from the browser with CSS `@page`: no PDF library.

Mandatory precautions: disable the printer's automatic fit-to-page, offer a calibration sheet with rulers to align the pitch, do not trust the nominal dimensions of the adhesive sheet.

### 5.4 Thermal printers

The initial use of **system print drivers** is approved: the browser prints on a page of fixed physical dimensions declared with `@page size` (for example 50×25 mm). No sending of raw commands.

Direct **ESC/POS commands remain out of scope**: they would require a network path or a local agent, with security and support implications not justified today.

Compatibility must be verified on at least two real models: the minimum module of the QR that is readable when printed on low-resolution thermal media is a physical limit, not a software one. Below a certain size the label prints but cannot be read.

### 5.5 Generation: `qrcode` (soldair), SVG first

| Item | Status |
| --- | --- |
| Candidate | **`qrcode`**, repository `soldair/node-qrcode` |
| Version declared by the repository | 1.5.4 |
| Licence | MIT |
| Declared direct dependencies | `dijkstrajs`, `pngjs`, `yargs` |
| Namesake package to exclude | **`node-qrcode`** (npm): last published 2015, version `0.0.4`, dependencies `debug ^2.2.0`, `get-port ^2.1.0`, `decompress ~3.0.0`, `node-browser`. It is not the intended library and must not be used. |
| Generation format | **SVG first**, PNG as alternative |
| Final approval | **Subject to** verification during implementation of security, maintenance, transitive licences and compatibility |

Adoption happens **server-side only**: the client receives ready-made SVG, no encoding code in the browser, a single point to verify. PNG remains available for uses where SVG is not supported.

The implementation verification must produce, before merge: fixed version, integrity hash, dependency tree of transitive dependencies with licences, date of last publication, number of maintainers, known vulnerabilities. If any of these items is unsatisfactory, the candidate is changed rather than accepting the risk silently.

### 5.6 Print tracking

Print event table with `site_id`, type and id of the entity, payload version, format, dimensions, quantity, author, timestamp and batch identifier. It serves reprints and reconstructing the provenance of a label found on site.

Physical durability (material, lamination, resistance to agents) is a procurement choice: it must be documented as a recommendation, not implemented.

## 6. Mobile scanning and contextual actions

### 6.1 Acquisition: native plus fallback decoder

| Path | Role | Constraint |
| --- | --- | --- |
| Native `BarcodeDetector` | First choice, no bytes added to the project | Requires a secure context (HTTPS); variable support across browsers and platforms |
| Alternative decoder loaded **on demand** | Compatibility guarantee where the native API is absent | Separate dependency, downloaded only when needed and only if the user accepts |
| Typing the code | Universal fallback | The code from §4.3 |

Explicit rule: the **native Barcode Detection API is not the only scanning system**. It is not acceptable for the functionality to depend on an API whose availability we do not control.

Acceptance criterion of the **first release**, not deferrable: real scanning verified on **Safari/iPhone** and **Chrome/Android**, on a physical device, with a printed label and not with a synthetic image on screen. If the native path does not cover one of the two platforms, the fallback decoder must already be integrated.

Other constraints: the camera opens only on explicit action, with a clear message about what is being framed; the code read is resolved by the server and the client does not interpret the payload to deduce the entity.

### 6.2 Direct opening of the record

The scan leads to the entity record in the owning module, with a provenance breadcrumb ("opened by scan") and a return to the inventory session if one exists. A payload that points to an entity of a module not granted produces an explicit refusal, not an empty screen.

### 6.3 Contextual actions

Actions depend on the entity type and on permissions, and are always executed by the owning module: identification introduces no writes of its own to master records.

| Entity | Contextual actions | Who |
| --- | --- | --- |
| Installed asset | Open record, record transfer, status transition, attach document, add to inventory session | Module roles according to `places-and-assets.md` §7 |
| Equipment | Open record, record use or maintenance, **open the linked HSE record** | Roles of the `tools` module |
| HSE asset | Open record, start inspection from template | HSE roles |
| Order line or parcel | Open order or shipment, record receipt | `logistics` roles |
| Unknown entity | Report as unknown in the session, request association | Inventory session roles |

No destructive action from scanning. Decommissioning remains an operation with a reason and confirmation on the record.

## 7. Inventory sessions

### 7.1 Model

A session is a piece of work bounded in time and space, with a declared scope: a subtree of places, a warehouse, or the whole site. It has a person in charge, a status (open, closed) and a stored result.

| Table | Content |
| --- | --- |
| `inventory_sessions` | `id`, `site_id`, scope, status, opening and closing, author, notes |
| `inventory_scans` | `id`, `session_id`, `site_id`, type and id of the entity (null if unknown), raw payload, `scanned_at`, author, **expected location as a snapshot**, **declared observed location**, **scan context**, outcome, `client_scan_id` for idempotency, note |
| `inventory_resolutions` | reconciliation decisions: scan or set of scans, applied outcome, author, timestamp, rationale |

The outcome of each scan is one of: **matching**, **duplicate**, **discordant location**, **unknown**, **unexpected**. Expected and observed positions are described in §7.5; the scan context in §7.6.

### 7.2 Consecutive scans

The screen stays open and acquires in sequence, without confirmation for each reading: one tap, one object, a brief visual and audio outcome. The count is always visible.

Each scan carries a `client_scan_id` generated by the device. The server is idempotent on that key: a double network submission does not produce two rows.

### 7.3 Duplicates

Behaviour distinct per domain, because "the same object twice" means different things:

- Assets and equipment: the second reading is a **duplicate** to be reported, not an increase in quantity. It serves to discover double labels or moved objects.
- Materials and items: repeated reading may be legitimate and increase a quantity, if the domain allows it.

The rule is per entity type, explicit and verifiable, not configurable at runtime in the first release.

### 7.4 Unknown items

An unresolved payload automatically creates nothing. It becomes an "unknown" row with the raw payload, and remains so until an authorised user decides: to associate it with an existing entity, or to start creation in the owning module through the normal flow. The closed session keeps the unresolved rows as part of the result.

### 7.5 Expected location and observed location

A survey records **two** positions, not one:

| Field | Meaning | Source |
| --- | --- | --- |
| **Expected location** | Where the object should be according to the system | Snapshot at the moment of scanning, calculated by the model (asset position, stock location) and stored as such |
| **Observed location** | Where the object was actually seen | The scan context chosen by the operator at the moment of reading |

Rules:

- The expected location is a **snapshot**: if the asset later moves, the survey continues to say where the system placed it on that day. Without this, every historical re-reading would be ambiguous.
- The observed location is **declared by the operator**, not inferred. If it is missing, the survey exists but the discrepancy cannot be assessed, and the outcome says so instead of inventing a place.
- The discrepancy arises from the **comparison** between the two. If the object is found in a place different from the scope or from the expected one, the session records it and corrects nothing: the official location changes only with an explicit movement, with reason and interval, as established in `places-and-assets.md` §3.
- A scan records a survey. It does not automatically modify either an accounting quantity or an official location. Reconciliation proposes the movement as a separate action, authorised and traced, subject to **movement approval** (§8).

### 7.6 Scan context and QR identification of places

Whoever inventories scans not only objects but **spaces**. Warehouses, containers and shelves must be identifiable like an asset or an item of equipment.

| Element | Behaviour |
| --- | --- |
| Scan context | The operator declares where they are: a place, a container, a shelf. The context applies to **subsequent** surveys until it changes |
| Place code | Same scheme as §4: URN with the UUID of the place and a printable, attachable short code |
| Scanning a place | **Sets the context** of subsequent surveys; does not modify official locations and creates no movements |
| Context change | Explicit and visible: the interface always shows the current context, so that a survey does not end up in the wrong place through distraction |
| End of session | The context does not survive the session: no implicit context inherited from a previous job |

The QR identification of places is therefore a natural extension of the same mechanism, not a separate feature: what changes is the entity type resolved, not the payload or the scanning behaviour.

Scanning a place is **not** a transfer. If the operator scans a shelf and then an asset that should not be there, the system records a discrepancy and proposes a movement: it moves nothing by itself.

### 7.7 Reconciliation, closure and immutability

Reconciliation produces: seen, not seen, duplicates, discrepant, unknown, with their respective counts. Closure freezes the result and requires an explicit decision on the unresolved items (accepted as such, or deferred).

A closed session is **immutable**: it is neither modified nor deleted. A correction is a separate traced act, citing the original session and preserving its content. The original result always remains readable.

### 7.8 Evidentiary diary

A **concluded** session may feed the diary with a **traceable summary**: scope, counts, outcome, unresolved items, author, reference to the session. The diary receives an event, not a stream.

- **No diary entry for an individual scan.** The diary is a register of significant facts, not a technical log.
- The summary cites the session by identifier, so that the fact remains verifiable even after a long time.
- An already inserted summary is not rewritten: a correction is a new entry that cites the previous one.

## 8. Permissions, distinct authorisations and isolation

### 8.1 Consultation and printing

The **permissions of the existing modules** are used, without introducing a new module for identification:

| Operation | Authorisation |
| --- | --- |
| Resolving an identifier, opening the record | Access to the owning module, according to the rules already in force |
| Printing labels | Same right as consultation: whoever can see the entity can print its label |
| Printing in bulk | Consultation of the module **plus** edit or owner role, to avoid unintended mass reprints |

Where a module does not exist — today for places and assets access depends only on the site role — the rule in force applies, and the gap is noted as such, not masked by a permission that does not exist.

**Scanning confers no additional authorisations.** Reading a label adds no rights: it opens what the user could already open and nothing more.

### 8.2 Consultation of sessions without access to the whole module

**Owner decision (27/11/2026):** consulting an inventory session must not require access to the entire Logistics module or to the owning module in its entirety.

| Situation | Behaviour |
| --- | --- |
| An area manager must see the session of their scope | **Limited** authorisation to the domain and site concerned, not to the whole module |
| The user has no access to the originating module of an entity | Sees the session row as a reference, **not** the entity record nor its data |
| Summaries and counts | Calculated **only** on what the caller can see; no total that reveals the existence of excluded records |
| Overlapping scopes | Each session declares its own scope; authorisation follows the scope, not the module hierarchy |

The risk to avoid is indirect exposure: a count that says "47 items not seen" reveals the existence of material the user cannot consult. The rule is therefore that **the summary is not a side channel**: if the detail is denied, the aggregate number that reveals it is also denied or shown in a form that cannot be traced back.

### 8.3 Four distinct inventory authorisations

| Authorisation | What it allows | Roles |
| --- | --- | --- |
| Opening and closing a session | Declare scope, open, close, decide on unresolved items | Owner; editor if assigned as person in charge |
| Recording surveys | Scan and record, including offline | Owner, editor, enabled verifier |
| Reconciliation of discrepancies | Propose associations and classify outcomes | Owner, editor |
| Approval of movements | Apply the proposed location movement | Owner; editor only if explicitly delegated |

Separating these four things is deliberate: whoever counts objects in the warehouse is not necessarily whoever decides that an asset has moved, and whoever reconciles must not be able to rewrite an official location on their own.

### 8.4 Isolation between sites

Every resolution, label and session is bound to a `site_id`. An identifier from another site is indistinguishable from a non-existent one. No cross-site aggregate count exposes the existence of other people's records. A label printed for a sandbox site is not valid on an ordinary site even if the UUID were known.

| Role | Identify and print | Session | Reconcile | Approve movements |
| --- | --- | --- | --- | --- |
| Owner | Yes, across the whole site | Opens, conducts, closes | Yes, including associations of unknowns | Yes |
| Editor | Yes, for the modules in which they write | Conducts an assigned session | Yes | Only if delegated |
| Verifier | Yes, read-only according to modules | Records surveys if enabled | No | No |
| Viewer | Only opening the record | No | No | No |
| Demo user | Only on sandbox sites, synthetic data | On synthetic data | No | No |

## 9. Offline — approved second phase

First release **online**. The second phase is approved in design, with these non-negotiable constraints.

| Capability | Phase | Rule |
| --- | --- | --- |
| Expected list in session | Phase 2 | Cache limited to the user's **authorised sites**, not to the archive |
| Recording surveys offline | Phase 2 | Dedicated queue with `client_scan_id`, deterministic deduplication, reordering on return to network |
| Cache of the identifier index | Phase 2, with explicit decision | **Minimisation**: only code and type, no personal data, no documents; short, renewable **expiry**; **immediate invalidation** on change of permissions, removal from the site and logout |
| Offline reconciliation | **Never** | Requires the complete view and a decision of responsibility: remains server-side |
| Offline creation of master records | **Never** | Master records are validated on the server; a new object is born online |

Surveys collected offline are **subject to permission verification and reconciliation at the moment of synchronisation**. A queue is not a shortcut: if on return to the network the user no longer has the permission, the survey is refused and kept as rejected, not applied.

## 10. Dependencies on existing modules

| Module | What it provides | Dependency | Risk if it changes |
| --- | --- | --- | --- |
| Places and Assets 2a | Place routes, movement, archiving, history | **Blocking** for session scope and expected location | Low on the identifier: no label depends on the path |
| Places and Assets 2b | Search by tag, asset record, positions, transitions | **Blocking** for scan destination and for movements | Low on the identifier, high on the experience |
| Equipment (`tools`) | Authoritative master record, status, free-text `location` | Required | Free-text `location` is not a place: do not use it as a reliable location |
| HSE assets (`hse_assets`) | Checks, fitness, safety; `tool_id` to `tools` | Required; a symmetric `asset_id` is needed for installed assets | Double label on the same physical object |
| Orders, parcels, shipments (032–034) | Order line, parcel, receipt | Partial: identifies the line, not the physical object | Presenting an order line as "material" would be misleading |
| **Site Materials & Inventory** | Item master, lots, locations, movements | **Blocking** for warehouse items and the logistic format | Without it, no item label |
| Attachments | Documents per entity | **Dependency of the document flows**, not of identification | Today `asset` and `place` are not covered; the record can identify but cannot attach |
| Audit (`audit_events`) | Trace of mutations, with `place`, `asset`, `tool` already admitted | Required for printing and reconciliation | — |
| Access per module | `MODULES`, strict modules | Existing permissions are inherited | A new module is not needed; gaps must be declared |

On attachments the decision is explicit: the extension to Places and Assets is a **dependency of their respective document developments**, not a prerequisite of simple QR identification. A label that opens a record without attachments is useful; a record with attachments is more useful, but it is not the same thing and must not be confused with it.

## 11. Verification of architectural non-prejudice

| Current choice | Effect on identification | Assessment |
| --- | --- | --- |
| Immutable UUIDs for assets and places (057) | Exactly the required support: independence from position and name | **Already compliant** |
| Tag unique only among non-archived records | Prevents using the tag as identity | **Already compliant**, provided the UUID is chosen |
| Half-open position intervals, one open interval | Distinguishes "where it should be" from "where it was seen" without ambiguity | **Already compliant** |
| Frozen `recorded_path` | The descriptive label shows the correct historical path | **Already compliant** |
| `hse_assets.tool_id` | The single identity principle is already realised for equipment | **Already compliant** |
| No `asset_id` in `hse_assets` | The principle is not yet extended to installed assets | **Known gap**, dedicated increment **approved** on 27/11/2026 |
| `material_no` as text on order lines | No item identity | **Gap**, requires Site Materials & Inventory |
| Attachments not extended to assets and places | The record cannot attach manuals and reports | **To be closed in the document flows**, not blocking |
| No dependencies beyond `pg` and WebAuthn | The QR encoder is the first non-infrastructural dependency | **Approved decision**, verification in implementation |
| Offline queue limited to four types | Offline inventory requires a new type | **Extensible**, mechanism already parametric |

Conclusion: **no current choice prevents the functionality**, and there is no need to modify 2a or 2b to prepare for it. The two things that would be costly to correct later are avoided by construction: the QR contains the UUID and not the tag; inventory never writes the position of an asset.

## 12. Proposed APIs

Prefix `/api/sites/:siteId`. Operations with historical effect are transactional; creations are retryable with `Idempotency-Key`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/identifiers/:payload` | Resolve a payload into entity type and id, with the caller's permissions. `404` if inaccessible or non-existent. |
| GET | `/identifiers/code/:code` | Resolve the typable code from §4.3 within the site scope |
| GET | `/labels?entityType=&ids=&format=&width=&height=` | Return labels in SVG (PNG on request) |
| POST | `/label-batches` | Register a print batch and return the document (single, A4 multiple) |
| GET | `/label-batches` | Print history, for reprinting |
| GET | `/label-profiles` `POST` `PATCH` | Format and dimension profiles per site |
| GET | `/inventory-sessions` | List with status and counts |
| POST | `/inventory-sessions` | Open a session with declared scope |
| GET | `/inventory-sessions/:id` | Detail with expected, seen, discrepancies, unresolved |
| POST | `/inventory-sessions/:id/scans` | Record a scan with **snapshot expected location**, **observed location** and **scan context**; idempotent on `client_scan_id` |
| PUT | `/inventory-sessions/:id/context` | Set the current scan context (place, container, shelf). Creates no movements |
| POST | `/inventory-sessions/:id/resolutions` | Record a reconciliation decision |
| POST | `/inventory-sessions/:id/close` | Close, freezing the result |
| POST | `/inventory-sessions/:id/amendments` | Traced correction of a closed session |

No write route on master records: contextual actions use the routes of the owning modules.

## 13. Acceptance criteria and negative tests

| Test | Verifiable outcome |
| --- | --- |
| Independence from location | Moving an asset does not change the payload resolved by an already printed label. |
| Independence from name | Renaming does not change resolution; the old descriptive label remains readable as data at the print date. |
| Independence from domain | The same payload resolves on two distinct environments. No URL in the canonical payload. |
| No sensitive data | The payload contains only URN schema and UUID: no name, serial number, token, date or signed URL. A tampered payload pretending to carry additional data is rejected. |
| No recycling | Decommissioning an asset and reusing its tag does not make the old label resolvable to the new asset. |
| Short code | The code from §4.3 resolves the correct entity and is stable after renaming, transfer and tag reuse. A code with a wrong character is rejected by the check character **before** the query. |
| Collision | Two entities never obtain the same short code within the same site, even under concurrent creation; when the attempts are exceeded the code is lengthened, not reassigned. |
| No reassignment of code | Archiving or decommissioning an entity does not free its code for a new entity. |
| Cross-site | An identifier from another site returns `404` without revealing name or existence; no count exposes it. |
| Single identity | An item present in `tools` and in `hse_assets` produces one authoritative label; an attempt to print two is flagged. |
| HSE reconciliation | An HSE asset with null `tool_id` is not linked automatically: the proposal requires confirmation of physical identity, remains traced and, if rejected, changes nothing. After linking there is one authoritative label. |
| Continuity of physical identity | The label printed on an instance at receipt continues to resolve the same object after installation: no reprint, no second identity, and the instance→asset link is explicit and traced. |
| Printing | Selecting one hundred entities produces one hundred labels and no extra records; reprinting does not duplicate; the preview reports the correct counts. |
| Dimensions | A 50×25 mm profile produces an SVG with those physical dimensions and a QR above the minimum readable module. |
| Print permissions | A viewer cannot start a bulk print; a user without access to the module obtains no labels and, if they invoke the route, is rejected. |
| Real scanning | **Safari/iPhone and Chrome/Android on physical devices** read a printed label and open the correct record. With the native API absent, the fallback decoder works. |
| Duplicates in session | Two scans of the same asset produce a reported duplicate, not a quantity of 2. |
| Unknown | An unresolved payload creates no entity; it remains unresolved and the session can close keeping it. |
| Discrepant location | A scan outside scope does not modify `asset_positions`; without approval of the movement the position remains unchanged. |
| Expected and observed location | The survey keeps both; if the asset moves afterwards, the recorded expected location does not change. A survey without observed location does not produce an invented discrepancy. |
| Scan context | Framing a place sets the context of subsequent surveys without creating movements or modifying official locations; the context does not survive the session. |
| Limited visibility | A user without access to the originating module sees the session row but not the entity record nor its data; summaries count only what they can see and do not reveal excluded records. |
| Four permissions | Whoever records surveys but lacks movement approval cannot apply a movement, either directly or through reconciliation. |
| Idempotency | The same `client_scan_id` sent twice produces a single row. |
| Closed session | Modifying a closed session is rejected; the correction produces a separate act and the original remains readable. |
| Diary | A closed session generates **one** summary entry, not one per scan; the entry cites the session. |
| Offline (phase 2) | With no network the interface does not pretend to have recorded a scan that is not queued; on return to the network a user without permission sees the survey rejected, not applied; the cache expires and is invalidated on logout. |

Constraint and concurrency cases must be run on SQLite and PostgreSQL.

## 14. Risks, out of scope and open decisions

| Risk | Planned control |
| --- | --- |
| Label illegible after months | QR above the minimum module verified on real printing; test on aged media |
| Label obsolete but not inert | Resolution that distinguishes non-existent, archived and deleted; no UUID reuse |
| Double identity on the same object | Authoritative register per domain; `asset_id` in `hse_assets` as a dedicated increment |
| Inventory perceived as automatic correction | Reconciliation proposes; the movement requires approval |
| QR dependency not under control | Fixed version, hash, transitive licences verified, declared debt |
| Site data copied to the device | Minimised cache, with expiry and invalidation, only for authorised sites |

Out of scope: linear barcodes beyond the QR, RFID, direct ESC/POS printing, labels with URL in the first release, stock management and valuation (which belongs to Site Materials & Inventory), native apps, digital signature of labels.

Decisions **closed** by the owner on 27/11/2026: single identity with authoritative Equipment; three label formats; printing with system drivers; permissions of existing modules with four distinct inventory authorisations; `qrcode` (soldair) as candidate subject to verification in implementation; SVG first; URL as a future option; real scanning on both platforms as first-release criterion; offline in second phase with limited cache; diary fed only by closed sessions; attachments as a document dependency and not of identification.

Decisions **closed in the review of 27/11/2026** (second round):

1. **`asset_id` in `hse_assets` is approved** as a dedicated increment, to avoid duplicate identities of assets subject to HSE checks (§3.1).
2. **The permanent short code is the chosen option**, in place of the 26-character derived code: check character, managed collisions, no reassignment, length validated in implementation (§4.3).
3. **`tools` remains the authoritative register** of equipment; for unlinked HSE assets explicit reconciliation with verification of physical identity is required, never association inferred from name or description (§3.3).
4. **Consultation of sessions does not depend on access to the whole module**: authorisations limited to domain and site, without indirect exposure through summaries and counts (§8.2).

Decisions **still open**:

1. **Timing of the `asset_id` increment**: whether before or after the first QR release, and whether it requires a backfill of HSE assets already registered.
2. **Definitive length of the short code**: 7 characters (6+1) as a working hypothesis, to be validated on a real mobile keyboard.
3. **Custody of physical verification**: who is enabled to confirm the identity of an unlinked HSE asset, and with what minimum acceptable evidence.
4. **Scope of visible sessions**: whether an area manager must see all sessions of their site or only those of their subtree of places.

## 15. Recommended sequence

| Phase | Content | Prerequisites |
| --- | --- | --- |
| Q0 | Prerequisites: 2a and 2b merged; verification of the QR dependency. The `asset_id` increment in `hse_assets` is approved but does not block Q1: it enters when the owner fixes its priority | 2a, 2b |
| Q1 | Identifier, typable code, resolution, compact and descriptive labels, single, bulk, reprint, preview, size profiles, A4 | Q0; migration for print events |
| Q2 | Mobile scanning with fallback decoder, opening of record, contextual actions, test on iPhone and Android | Q1 |
| Q3 | Inventory sessions, duplicates, unknowns, discrepancies, reconciliation, four authorisations, summary in the diary | Q2; pair of migrations |
| Q4 | Offline acquisition with limited cache, expiry, invalidation, permission verification at synchronisation | Q3 |
| Q5 | Logistic label and items | **Site Materials & Inventory** implemented |
| Q6 | Labels with URL for stable domains | Q1; decision on the list of admitted domains |

No phase requires changes to increments 2a and 2b.
