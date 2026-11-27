# SiteAssistant roadmap

**Derived** document. The authoritative sources are the cards of the `siteassistant` board; this file is their readable representation and must be updated when each increment is merged. In case of divergence, the card prevails.

## Product vision

Direction confirmed by the owner on 27/11/2026, document `docs/product-vision.md`.

Three pillars — **Site Execution** (WBS, tasks, progress, resources, commitments, deviations), **Site Logistics** (procurement, shipments, materials, inventory, assets, equipment) and **Site Assurance** (HSE, quality, inspections, evidence, verifications, handover, Permit to Work) — on shared foundations: places, people, companies, identity, permissions, evidentiary diary, jurisdictions, documents, audit trail.

It serves to establish where a requirement lives and to prevent duplication between modules. It is neither a refactoring mandate nor a change of priority: Places and Assets 2a and 2b remain first.

## Agreed HSE sequence

| Order | Phase | Status | References |
| --- | --- | --- | --- |
| 1 | Inspection safety hardening (Phase 0) | **done**, in `main` with `d9beec3` | Phase 0 card; migration 056; criteria F0-01…F0-10 formalised in the comment on PR #62 |
| 2 | Foundations | to be opened | depends on places/assets and people/companies |
| 3 | Audit and inspections | backlog | cards C-03…C-13 |
| 4 | Handover | backlog | Handover card |
| 5 | Permit to Work | backlog, not active | Permit to Work card (separate design) |

## Functional flows

### 1. Places and installed assets — first functional increment
Specification in `docs/places-and-assets.md` (PR #58). Hierarchy site → building → floor → zone → room, asset register with lifecycle and warranty, location intervals. Unblocks the evidentiary diary, quality, documents and handover.

### 2. People, companies and external participation
Specification in `docs/people-and-companies.md` (PR #59). To be built together with places to avoid duplicate registers: an asset has an installer, a place has a manager, a task has an executor and a verifier.

### 3. Evidentiary diary and visual archive
Specification in `docs/evidentiary-diary.md` (PR #60). Depends on places (where) and people (who signs), and on the existing attachments.

### 4. Weekly commitment cycle
Specification in `docs/weekly-commitment-cycle.md` (PR #61). Depends on tasks and crews; feeds the diary with commitments kept or missed.

### 5. Country modules and content language
Specification in `docs/country-modules.md` (PR #61). Cross-cutting: touches documents, HSE, units and formats. The Northline IT/UK fixtures (`d8dc3cb`) are the test basis.

### 6. QR identification, labels and physical inventory
Specification in `docs/qr-identification-inventory.md`. Born from operational experience with InsiteLMS. Covers QR identification of installed assets, equipment and — when the materials module exists — warehouse items; labels in three formats (compact, descriptive, logistic); single, bulk, reprint, preview and customisable sizes on A4 and with system drivers; mobile scanning with opening of the record and contextual actions; inventory sessions with duplicates, unknowns, discordant locations and reconciliation. **Specification only**: no implementation authorised, no dependency installed.

Decisions approved by the owner on 27/11/2026: single identity per physical object with Equipment as authoritative and HSE not duplicating the identity; versioned canonical URN payload with UUID, independent of tag, location and domain; typable code not based on the tag; `qrcode` (soldair) as candidate, with SVG as priority and PNG as alternative, approval subject to verification during implementation; real scanning on Safari/iPhone and Chrome/Android as the first-release criterion with a fallback decoder loaded on request; permissions of the existing modules plus four distinct authorisations for inventory (opening/closing, recordings, reconciliation, approval of movements); diary fed only by closed sessions with traced corrections; offline in a second phase with limited cache, expiry and invalidation.

Dependencies: 2a and 2b merged (API and asset record); Site Materials & Inventory module for items and the logistic format; extension of attachments to Places and Assets as a dependency of document flows, **not** of identification. The choices in 057 do not preclude the functionality: the QR carries the UUID and not the tag, and inventory proposes movements without applying them.

Second round of decisions (27/11/2026, review of the specifications): **permanent short code** in place of the 26-character derived code, with a check character, managed collisions and no reassignment; **`asset_id` in `hse_assets` approved** as a dedicated increment; **authoritative `tools`** with explicit reconciliation and physical verification for unlinked HSE equipment, never inferred associations; **sessions viewable with limited authorisations** to the domain and the site, without indirect exposure through counts. Integrations adopted: continuity of physical identity between goods receipt and installation (no reprint, no double identity); **expected and observed** location in every recording, with scan context and the QR codes of places setting the context without moving anything.

### 7. Site Materials & Inventory
Specification in `docs/site-materials-inventory.md`. Autonomous module for on-site logistics operations: item register with codes and aliases, units of measure and quantities, serialised and non-serialised items, lots from the first movement release with configurable mandatory use, parcels and pallets, links to orders and goods receipts, locations as places with flexible granularity, append-only movements with **quantity and custody statuses**, link to installed assets, physical inventory and quantity reconciliation. **Specification only**: implementation not authorised.

Movement semantics approved on 27/11/2026: five distinct statuses (storage, custody, assigned, consumed, returned) instead of a single on-hand quantity. Withdrawal is neutral on the physical present, and consumption subtracts once: with a single on-hand quantity, withdrawal plus consumption would subtract the same object twice. Module `materials` **strict**, like `logistics`. Separate registers per site in the first release.

Declared boundary: SiteAssistant does not become a general ERP or WMS. Out of scope: master bases, cycles, MRP, valuation, FIFO/LIFO accounting and tax traceability. Today materials exist only as a text `material_no` on order and parcel lines (032–034): there is no stock, no item identity, no link to what is installed.

### 8. Other flows, not yet specified
Quality and acceptance, document register, attention and escalation, measurement and value, closure and handover, Northline pilot, comprehension test of the demo.

## Consolidated technical base

- Resilient migrations: manifest with checksums, order tracking, catalogue snapshots for SQLite and PostgreSQL 16 (`674143e`).
- `demo_seed_records` in the schema, migration 054 (`3979020`).
- Safety guards on demo seed and reset, migration 055 (`f262e61`).
- Deterministic Northline fixtures (`d8dc3cb`).
- Automatic `demo_user` on visitor approval (`3313f4e`).
- Demo reconciled on a new database, path A, with the old database kept as `siteassistant_legacy`.

## Governance

- **Single coordination**: Cleo, regardless of session or channel. Sessions do not operate as independent coordinators.
- **Assignment**: each card has an operational owner identified before it starts.
- **Migrations**: numbering reserved centrally; last published 056. A new migration takes the next number only after the previous one is merged.
- **Branches**: non-overlapping scopes; declare the files touched in the card or in the take-over comment.
- **Merge order**: explicit dependencies in the card; whoever merges verifies that the prerequisites are already in `main`.
- **Decisions**: every decision taken in a session must be written in the relevant card, so that other sessions see it.

## Open decisions

| Topic | Who decides | Status |
| --- | --- | --- |
| Re-enabling the nightly demo reset | owner | no active cron or timer; last scheduled run 26/11 04:00 |
| QR label: authoritative subject when `tools` and `hse_assets` describe the same object | owner | closed on 27/11: `tools` authoritative, explicit reconciliation with physical verification; open at the time of the `asset_id` increment (`docs/qr-identification-inventory.md` §14) |
| `materials` module: *strict* visibility like `logistics` | owner | closed on 27/11: strict approved; five decisions remain in `docs/site-materials-inventory.md` §14 |
| Mobile and rented containers: site location or tracked object in its own right | owner | `docs/site-materials-inventory.md` §14 |
| Restore drill D3 | owner | owner's card, does not block development |
| Release of the legacy database | owner | minimum retention 7 days, no deletion authorised |
| Legal validity of the signature in the diary | owner | declared in `docs/evidentiary-diary.md` §10 |
| Duration and creators of external links | owner | declared in `docs/people-and-companies.md` §9 |
