# Site Materials & Inventory

Proposal for SiteAssistant, verified against `origin/main` at commit `0e44e3c`. Standalone module approved by the owner on 27/11/2026 and added to the roadmap. **Specification only**: no implementation authorised, no dependency installed. Reference card: *Site Materials & Inventory* on the internal Workboard.

Scope declared by the owner: **operational site logistics**. SiteAssistant must not become an ERP or a general-purpose WMS. This constraint is not rhetorical: it is the criterion by which, in every section, a requirement is accepted or rejected.

## 1. Why a separate module

Today materials exist only as text. `purchase_order_items.material_no` and `package_items.material_no` are strings on supply documents (`032_purchase_orders.sql`, `033_packages.sql`): they describe what was ordered and packed, not an item with an identity.

The practical consequences are three, and they are the ones the module must resolve:

1. **No stock on hand.** It is known what was ordered and what arrived, not what is on site now.
2. **No identity.** The same item appears with different codes from different suppliers, and nothing says they are the same object.
3. **No link to the installed.** An item consumed to install an asset leaves no trace of the connection.

The module closes these three gaps and stops there. Everything that belongs to warehouse accounting, valuation, MRP, demand planning or tax traceability stays outside.

## 2. Boundary: what is inside and what is outside

| Inside (site logistics) | Outside (general-purpose ERP/WMS) |
| --- | --- |
| Site item master with internal code | Bills of materials, production routings, MRP |
| Units of measure and quantities | Valuation, warehouse costs, accounting FIFO/LIFO |
| Lots, parcels, pallets | Tax traceability and legal serialisation |
| Site locations (area, container, shelf) | Route optimisation, slotting, automation |
| Movements: receipt, withdrawal, consumption, return, adjustment | Transfers between plants, customs, Intrastat |
| Assignment to WBS or task | Supply contracts, tenders, full supplier management |
| Physical inventory and reconciliation | Full purchase-to-pay cycle, payments, invoice reconciliation |

A requirement that does not serve to know **where the materials are and what they are assigned to** does not belong to this module.

## 3. Item master and item codes

### 3.1 Entities

| Table | Content |
| --- | --- |
| `stock_items` | UUID `id`, `site_id`, `code` (internal code), `description`, `category`, `base_unit`, `is_serialized`, `manufacturer`, `manufacturer_code`, status, creation and modification dates, `archived_at` |

Rules:

- **`code` is internal and stable.** It is the identity of the item on site: it does not change if the description changes, and it is not reused after archiving. Unique within the site, even against archived records.
- **The supplier's code is not the identity.** `manufacturer_code` and the codes of suppliers live in an alias table (`stock_item_codes`), with a `namespace` for the source — the same approach already approved for place aliases in `places-and-assets.md` §2: `site_id + namespace + code → stock_item_id`. The same code in different namespaces is admitted; the same canonical code in the same namespace is rejected with `409`.
- **No description as identity.** Two items with the same description remain two items.
- **Logical archiving.** An item with stock or movements is not deleted: it is archived, and remains consultable.

### 3.2 Categories and serialisation

`is_serialized` distinguishes two natures that must be treated differently throughout the module:

| Type | Identity | Stock | Example |
| --- | --- | --- | --- |
| Non-serialised | The item, counted in units | Aggregate quantity | Screws, membranes, cable by the metre |
| Serialised | The **physical instance**, with its own serial number | One unit per instance | Panel, motor, transponder |

For serialised items an instance table (`stock_instances`) is needed with UUID `id`, `stock_item_id`, `serial_number`, status, current location and link to the installed asset when installation takes place. The serial number does not identify by itself: the identity is the UUID of the instance.

The link with the QR module is direct: **a serialised instance is a physical object with a permanent identity**, so it receives its own label according to `docs/qr-identification-inventory.md`.

## 4. Units of measure and quantities

- Each item has a **base unit** (`base_unit`) in which stock is held: `pz`, `m`, `m2`, `m3`, `kg`, `lt`, `conf`.
- Alternative purchase and consumption units (box, pallet, reel) are declared with a conversion factor to the base unit, kept per item.
- **The quantity is always kept in the base unit.** Conversions take place on reading, not on writing: this way a wrong conversion does not corrupt the history.
- Rounding: at least three decimals are kept, as `package_items` and `shipment_receipts` already do (`NUMERIC(12,3)`). No silent rounding in stock.
- Negative quantities are not admitted as a final stock status; a withdrawal that would produce them is rejected with `409` and a message stating how much is available.

## 5. Lots, parcels and pallets

Three distinct levels, often confused and which must be kept separate:

| Level | What it is | Identity | Exists today |
| --- | --- | --- | --- |
| **Lot** | Set of material with the same provenance or the same production number | `stock_lots` with `lot_no` per item and site | No |
| **Parcel** | Physical packed unit that can be moved, already modelled | `packages` (033) | **Yes** |
| **Pallet** | Aggregation of parcels for transport | Relation between parcels and handling unit | No |

Project decisions:

- The **parcel is not duplicated**: `packages` exists and remains the reference. The materials module extends it with the content of real items (`stock_item_id`), instead of introducing a second concept of parcel.
- **The lot enters from the first release of movement handling** (owner decision, 27/11/2026). It is not a deferred feature: movements are born already with the lot provided.
- **Configured, not universal, requirement.** The lot is mandatory by category or by individual item, according to an explicit configuration (`lot_required`). For items that require it — cables, materials with production date, components subject to recalls — a movement without a lot is rejected with `422`. For the others the lot remains optional.
- **No placeholder lot.** An item not subject to lots does not receive a placeholder lot such as `N/A` or `DEFAULT`: an invented value pollutes the groupings and makes it impossible to distinguish the tracked from the untracked. If the lot is missing, the field is null.
- The **pallet** is a grouping, not a container: identified by a logistic label, it contains parcels, it does not own them.
- The **logistic** label format of `qr-identification-inventory.md` §5.1 prints item, quantity, lot, parcel and destination: it therefore depends on these entities, not only on the master record.

One consequence to make clear: with the lot mandatory by category, **activating that configuration on an item that already has movements without a lot** is a change that must be managed. The configuration applies to subsequent movements; historical movements remain without a lot and are not rewritten. The interface declares how many existing movements lack one before applying the change.

## 6. Links to orders, shipments and receipt

The module **does not rewrite** procurement: it builds on what exists.

| Link | From | To | Rule |
| --- | --- | --- | --- |
| Order line → item | `purchase_order_items.material_no` | `stock_item_id` | Explicit, approved resolution, never inferred from text. The original code, source and resolution status remain visible. |
| Parcel → items | `package_items` | `stock_item_id`, `stock_lot_id`, quantity | Addition of references; the parcel remains the same entity |
| Receipt → movement | `shipment_receipts` | receipt movement | The receipt records the quantity received; the movement translates it into stock. **They are two acts, not one.** |
| Order → assignment | `purchase_order_items.wbs_id` | WBS or task | Already existing; the module inherits it and does not reimplement it |

The delicate point is the last row of the movements table: **receipt is not stock**. Today `shipment_receipts` says how much arrived. If the material arrives on site and is immediately taken to the plan, stock still changes. Keeping the two acts distinct prevents a receipt from becoming a stock level by magic.

## 7. Warehouse locations

Here the temptation to widen the scope is at its maximum, and it must be rejected.

**Not** introduced: a separate and complete warehouse hierarchy (aisles, shelves, containers with coordinates). What exists is used: **places** (`places`, 057) with the type that is needed.

Decisions of the owner (27/11/2026):

- **`storage_area` and `container` are admitted extensions** of place types, subject to verification of two things during implementation: consistency with the existing hierarchy (`building/floor/zone/room`) and the case of **mobile containers**, which may change site or be rented for short periods. A container that moves is a place that moves: admitted only with explicit rules, otherwise it becomes an alias of the lorry.
- **Flexible granularity, not a rigid hierarchy.** Zone, container, shelf and optional position are levels usable **without an obligation of completeness**: a depot may stop at the zone, an organised warehouse may go down to the shelf. No level is mandatory beyond the one that identifies the place.
- Flexibility is not a licence for a WMS: no aisles with coordinates, no warehouse maps, no optimised routes. The granularity serves to **find** things again, not to plan their handling.

Design rules:

- A material location is a **place** of the site — typically a zone or a room used as a depot — or a **container** declared as a place of a dedicated type.
- New types are added by extending the `kind` values of `places` through a migration, not by creating a second hierarchy.
- Stock per location is derived from movements, not from a "current quantity" field updated by hand. Such a field is the first source of inconsistency in any warehouse system.
- Moving between locations is a movement, with author, timestamp and reason, exactly as for assets.
- Every location is identifiable with a QR, like every other place: see `qr-identification-inventory.md` §7.6. Framing a shelf sets the context of surveys; it moves nothing.

## 8. Movements, quantity states and custody

### 8.1 The problem to avoid

With a single "withdrawal" movement type that subtracts, the real path — depot → crew → installation → consumption — produces **two subtractions for one object**: one at withdrawal, one at consumption. Stock collapses to half of reality and nobody knows whether the material is in the depot, in the hands of the crew or already fitted.

Owner decision (27/11/2026): the semantics must be distinguished. Withdrawal **is not** consumption, and consumption must not subtract a second time.

### 8.2 Five quantity states

The quantity of an item is not a single number, but a breakdown across states. For each combination of item, lot and location:

| State | Meaning | Still physically on site |
| --- | --- | --- |
| **`depot`** | Available in the depot, not committed | Yes |
| **`custody`** | Left the depot, in custody with a crew, an area or a task | Yes |
| **`consumed`** | Consumed: installed, incorporated or destroyed in use | **No** |
| **`returned`** | Returned to the supplier or came back and closed | **No** (if to the supplier) |
| **`assigned`** | Committed to a WBS or a task, **not yet** left the depot | Yes, but reserved |

Two derived quantities, which are not states but readings:

- **Available** = `depot` − `assigned`. This is what can still be withdrawn.
- **Physically present** = `depot` + `custody`. This is what exists on site, however placed.

`assigned` is a **reservation**, not a physical movement: it moves nothing and does not reduce what is physically present. It serves to answer "how much can I still withdraw without taking material from another task".

### 8.3 Movement types and transitions

| Type | From | To | Effect |
| --- | --- | --- | --- |
| `receipt` | — | `depot` | + present, + depot |
| `issue` | `depot` | `custody` | **neutral on present**, − depot, + custody |
| `consume` | `custody` | `consumed` | − present, − custody (terminal) |
| `return_to_depot` | `custody` | `depot` | neutral on present, − custody, + depot |
| `return_to_supplier` | `depot` | `returned` | − present, − depot (terminal) |
| `transfer` | location A | location B, same state | neutral on everything except distribution |
| `reserve` | — | `assigned` | neutral on present, reduces available |
| `release` | `assigned` | — | neutral on present, restores availability |
| `adjust` | any | any | ± with mandatory justification and dedicated authorisation |

The central point: **`issue` does not subtract from present and `consume` does not touch the depot**. An object withdrawn and then consumed passes through two states and is subtracted **only once**, at the end.

### 8.4 Conservation invariants

These hold for every item, lot and location, and must hold under concurrent writes:

1. **Non-negativity.** No state falls below zero. An operation that would produce this is rejected, not rounded to zero.
2. **Conservation of present.** For every non-terminal movement (`issue`, `return_to_depot`, `transfer`, `reserve`, `release`), the algebraic sum of the variations in physical present is **zero**.
3. **Terminality.** Only `consume` and `return_to_supplier` reduce present, and they reduce it exactly by the quantity moved. No other type can do so.
4. **Sum of states.** For every combination: `depot + custody + consumed + returned` = total entered minus total taken out of the system, and the sum of the variations of the four states for each movement is zero, except for movements that cross the system boundary (`receipt`, `return_to_supplier`).
5. **Custody limited to the holder.** Custody is registered to a holder (crew, area, task). Nothing more is consumed or returned than that holder has in custody.
6. **Non-negative available.** `depot − assigned ≥ 0`. No material is reserved that does not exist.
7. **One consumption per serialised instance.** A consumed instance does not become available again: its quantity is 1 and the transition is terminal.
8. **Traceability of the link.** Every `consume` cites the custody it comes from, or the composite operation that created it (§8.5). No orphan consumptions exist.

These invariants must be verified **within the same transaction that writes the movement**: the availability check and the write cannot be separated, otherwise two concurrent requests both pass the check and one leaves stock negative.

### 8.5 Direct consumption from the depot

An operator who takes a box of screws and uses them straight away must not have to perform two steps on two screens. But the shortcut must not break the model.

Rule: direct consumption from the depot is admitted as an **atomic composite operation**, which writes two distinct movements in a single transaction and links them:

1. `issue` from `depot` to `custody` towards a declared holder (the crew or the task);
2. `consume` from that custody to `consumed`, referencing the first movement.

The resulting history is honest: the passage into custody is visible, who had the material and the consumption. Stock is subtracted **only once**, because the `issue` is neutral on present. If either write fails, neither is recorded.

By contrast, a `consume` that skips custody without a trace is not admitted: it would be indistinguishable from an adjustment and would hide who had the material.

### 8.6 Withdrawal towards a crew or installation area

- Withdrawal requires a **holder**: a crew, an installation area or a task. A withdrawal "to nobody" does not exist, because it would not be reconcilable.
- Material in custody remains **present** on site: whoever looks at availability in the depot sees less, whoever looks at physical presence sees the same total. This is the correct reading in both cases.
- Custody **does not expire by itself**. A site that ends with material in custody to a crew must close that custody with a consumption or a return: there is no silent adjustment at the end of the project.
- On closing a task with residual custody, the system **flags** it and asks for a decision. It does not consume or return on its own initiative.

### 8.7 Assignment (reservation)

- Assigning material to a WBS or a task **is not a physical movement**: it reduces availability and nothing more.
- The assignment refers to a quantity of `depot`. If the material is already in custody, the assignment makes no sense: it is already committed in fact, and the system says so instead of accepting contradictory data.
- Releasing an assignment restores availability, never touching what is physically present.
- An assignment does not prevent a withdrawal by another holder, but the withdrawal consumes availability and can therefore reduce reserved material. The policy — block or warn — is an open decision (§14).

### 8.8 Negative cases

| Case | Outcome |
| --- | --- |
| Withdrawal above the depot | `409`, with the available quantity in the message |
| Consumption above the holder's custody | `409`; whoever consumes cannot use material in custody of another |
| Reservation above what is available | `409` |
| Return to depot of more than is in custody | `409` |
| Second consumption of the same serialised instance | `409`, the instance is terminal |
| Consumption without holder or composite operation | `422`, the custody trace is missing |
| Transfer between incompatible states (for example custody → `consumed` with type `transfer`) | `422`, the movement type does not admit that transition |
| Adjustment without justification | `422` |
| Adjustment by a user without the dedicated authorisation | `403` |
| Closing a task with residual custody | Blocking flag requiring a decision; no automatism |

### 8.9 Other rules

- **Append-only.** A movement is not modified and not deleted. A correction is a movement of opposite sign with justification and reference to the original.
- **Idempotency.** Every movement accepts an idempotency key: a double submission does not duplicate a stock level.
- **Consumption linked to installation.** When a serialised item is installed, the consumption is linked to the asset created and the instance keeps its own physical identifier: see `qr-identification-inventory.md` §4.6. For non-serialised items the link is by quantity, not by individual piece.
- **Readings always derived.** Availability, physical presence and breakdown by state are calculated from movements. No quantity field is updated by hand.

## 9. Link with installed assets

The module does not create assets: assets live in `assets` (057) and that register remains authoritative for their identity.

| Situation | Behaviour |
| --- | --- |
| Serialised instance installed | The instance becomes an asset: the record is created in `assets`, `stock_instances.asset_id` is linked, the consumption is recorded. One physical object, one identity. |
| Consumable material for installation | Consumption movement linked to the asset or the task, without creating an asset |
| Replaced component | New instance linked to the new asset; the old one remains in history with its serial number |
| Item not installed | Remains in stock: no asset until it is installed |

The criterion: **a physical instance becomes an asset only when it is installed.** Before, it is material. After, it is an asset. The identity of the instance does not change in the transition: the register that describes it changes, and the link states so.

## 10. Physical inventories and reconciliation

The physical inventory is the point of contact with `qr-identification-inventory.md` §7: sessions, scans, duplicates, unknowns and discrepancies are specified there. Here only what concerns quantities is declared.

- An inventory session on materials compares **expected** and **counted** per item, lot and location.
- The difference generates an **adjustment proposal**, not an adjustment. Application is an `adjust` movement, with mandatory justification and a distinct authorisation.
- Whoever counts does not adjust on their own: the separation of the four authorisations of `qr-identification-inventory.md` §8.3 applies here too, and approval of movements is the gate.
- The closed session is immutable; the correction is a separate traced act.

## 11. Permissions

**Owner decision (27/11/2026): `materials` is a *strict* module, like `logistics`.**

The module enters `MODULES` (`server/module-access.mjs:4-7`) and is added to the `strictModules` set with the same setting as `logistics`: nobody sees it without explicit grant. The reason is that quantities, destinations and holders have the same reserved character as logistics, which is already strict.

| Authorisation | What it allows | Roles |
| --- | --- | --- |
| Consultation of master record and availability | Seeing items, locations, quantities | Module access |
| Ordinary movements | Receipt, withdrawal, return, transfer, assignment | Owner, editor |
| Consumption | Declaring consumption on an installation or a task | Owner, editor |
| Adjustments | `adjust` movement | Owner; editor only if delegated |
| Item and alias configuration | Creating and correcting master records, approving resolutions from order lines | Owner, editor |

**Master records separate per site in the first release** (owner decision). An identical item on two sites is two records. A shared company catalogue is a future evolution, not an assumption to prepare today with global keys: sharing opens problems of authorisation and data ownership that must be addressed when a real need exists.

Isolation: every item, instance, lot, holder and movement belongs to a `site_id`. An identifier from another site is `404`, indistinguishable from non-existent. Aggregate counts do not reveal the existence of excluded records: the rule of `qr-identification-inventory.md` §8.2 applies here too.

## 12. Migration and coexistence with the existing

1. **Read-only inventory** of distinct `material_no` values per site, with counts and variants, to understand what really exists before proposing a master record.
2. **No automatic backfill.** Order lines remain as they are until an explicit resolution links them to an item. A `material_no` does not become an item by inference.
3. **Pair of migrations** for SQLite and PostgreSQL, number following 057 after merge. Extension of `packages` and `package_items` with optional references; no rewriting of existing columns.
4. **Existing clients intact**: procurement continues to work without the materials module. The module adds routes, it does not change them.
5. **Operational rollback**: disable the module per site, leaving procurement intact; the records created remain consultable.

## 13. Acceptance criteria and negative tests

| Test | Verifiable outcome |
| --- | --- |
| Item code | Two items with the same code in the site are rejected `409`, even with concurrent requests; the same code in different sites is admitted. |
| Code reuse | Archiving an item does not free the code for a new item. |
| Alias | The same supplier code in different namespaces is admitted; the same canonical code in the same namespace is rejected `409`. |
| Units | A quantity entered in an alternative unit is kept in the base unit with the correct factor; no rounding loses decimals. |
| Negative stock | A withdrawal above availability is rejected `409` with the available quantity; no state falls below zero. |
| **No double subtraction** | Reserving, withdrawing and then consuming the same quantity leaves physical presence reduced **once**, by the quantity consumed. This case is the central proof of the semantics of §8. |
| **Neutral withdrawal** | An `issue` from depot to custody does not change physical presence: it reduces the depot, increases custody, the total remains identical. |
| **Holder custody** | Holder A cannot consume or return more than they have in custody; the attempt with material in custody of B is rejected `409`. |
| **Composite consumption** | Direct consumption from the depot records two movements linked in the same transaction; if the second fails, the first is not left written. A `consume` without custody or composite operation is rejected `422`. |
| **Reservation** | Assigning does not change physical presence; `available = depot − assigned` does not fall below zero; releasing restores availability without physical movements. |
| **Residual custody** | Closing a task with residual custody produces a blocking flag; no consumption and no return are recorded on its own initiative. |
| **Concurrency** | Two concurrent withdrawals that together exceed the depot: one passes, the other is rejected `409`; the check and the write happen in the same transaction. |
| Immutable movement | Modifying or deleting a movement is rejected; the correction is an opposite movement with reference to the original. |
| Idempotency | The same movement sent twice produces one row and one quantity variation. |
| Receipt ≠ stock | Recording a receipt does not increase availability until the entry movement is recorded; the two counts remain distinguishable. |
| Serialised | A serialised instance cannot exist twice with the same serial number in the same site; the second consumption of the same instance is rejected `409`. |
| Mandatory lot | On an item with `lot_required`, a movement without a lot is rejected `422`; on an item without the requirement the lot remains null, never a placeholder value. |
| Lot activated retrospectively | Activating the requirement on an item with historical movements does not rewrite history and declares how many movements lack one. |
| Inventory | A session produces an adjustment proposal, not an adjustment; without authorisation for adjustments the `adjust` movement is rejected. |
| Isolation | An item or a movement from another site is `404`; no aggregate count exposes it. |
| Coexistence | Procurement works without the module; with the module active, pre-existing routes behave as before. |

## 14. Risks, out of scope and open decisions

| Risk | Planned control |
| --- | --- |
| The module drifts towards ERP | Boundary declared in §2; a requirement that does not concern where materials are and what they are for is out of scope |
| Double master record alongside the text of order lines | Explicit resolution, no inferred backfill; original text preserved |
| Stock diverging from reality | Stock derived from movements, never a field updated by hand; periodic inventory |
| Second concept of parcel | `packages` remains the only one; the module extends it |
| Locations as a parallel hierarchy | Places are used; no second hierarchy |
| Master record shared between sites | Excluded in the first release |

Out of scope: bills of materials, routings, MRP, valuation and costs, accounting FIFO/LIFO, tax traceability, transfers between plants, customs, full supplier management, payments, integration with external systems, native apps.

Decisions **closed** by the owner on 27/11/2026:

1. `materials` is a **strict** module, like `logistics` (§11).
2. **Lots enter from the first release of movement handling**, with mandatory status configured by category or item and no placeholder lot (§5).
3. **`storage_area` and `container` are admitted extensions** of place types, subject to verification of hierarchical consistency and the case of mobile containers (§7).
4. **Master records remain separate per site** in the first release; the shared company catalogue is a future evolution (§11).
5. **Flexible granularity** of locations — zone, container, shelf, optional position — without rigid hierarchy and without WMS (§7).

Decisions **still open**:

1. **Mobile containers**: whether a rented and movable container is a place of the site or an object tracked in its own right. This changes the model, not just the label (§7).
2. **Reservation policy**: whether a withdrawal that affects material assigned to another task should be blocked or only flagged (§8.7).
3. **Custody holder**: whether it may be a person in addition to crew, area or task. A person is more precise and more fragile (turnover, leave, disputes).
4. **Closing a task with residual custody**: whether the flag should be blocking or only a persistent warning (§8.6).
5. **Minimum mandatory granularity**: whether every movement must declare the location down to the shelf, or whether the zone is enough as default.

## 15. Recommended sequence

| Phase | Content | Prerequisites |
| --- | --- | --- |
| M0 | Decisions of §14; read-only inventory of `material_no` | — |
| M1 | Item master, codes, aliases, units of measure, **lots with configurable mandatory status** | M0; no dependency on other modules |
| M2 | Movements with **quantity and custody states** (depot, custody, assignment, consumption, returns), derived availability, locations as places | M1 |
| M3 | Links to orders, parcels and receipts; resolution of order lines | M2; procurement (032–034) |
| M4 | Serialised instances and link to installed assets | M3; 2b for assets |
| M5 | Physical inventory and reconciliation of quantities, with expected and counted location | M4; inventory sessions from QR (Q3) |
| M6 | Logistic label | M4; Q1 of labels |

The module has no dependency on 2a and 2b for the first three steps, but it must not start before the agreed operational priority allows it: increments 2a and 2b stay ahead.
