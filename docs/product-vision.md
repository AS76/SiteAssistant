# Product Vision & Functional Architecture — Three Pillars

Status: **product direction confirmed by the owner on 27/11/2026**.
Reference card: `d57ae22c`.
Nature of the document: architectural guidance. **It is not** a mandate for refactoring, for reorganising the interface, or for changing current priorities.

## 1. Why three pillars

SiteAssistant grows through increments chosen from a real operational need. That is the right way to build, but it produces a predictable drift: modules that resemble each other without knowing it, parallel registers of the same object, functions duplicated across domains.

The three pillars are not an organisation chart or a new navigation. They are a **membership criterion**: given a requirement, it is known which domain it lives in, who owns it and — above all — whether it duplicates something that already exists.

## 2. The three pillars

| Pillar | Scope | Question it answers |
| --- | --- | --- |
| **Site Execution** | WBS, tasks, progress, resources, weekly commitments, deviations | What needs doing, by whom, and where it stands |
| **Site Logistics** | Procurement, shipments, materials, inventory, assets and equipment | What arrives, where it is, what is installed |
| **Site Assurance** | HSE, quality, inspections, evidence, verifications, handover, Permit to Work | How I show it was done well, and who signs it off |

The three pillars touch each other but do not overlap: a task (Execution) consumes material (Logistics) and produces evidence (Assurance). Material is not a task, and evidence is not a warehouse movement.

## 3. The shared foundations

Places · people · companies · identity · permissions · evidentiary diary · jurisdictions · documents · audit trail.

These are **foundations, not pillars**. They do not belong to one domain because all three depend on them in the same way: a place is not "logistics", it is the place where tasks, materials and inspections happen.

The operational consequence is a simple rule: **a foundation is extended for a cross-cutting need, not for the convenience of a single pillar.** If one pillar asks to change the model of places for itself, the request must be assessed against the other two.

## 4. Mapping verified against the code

Reference: commit `0e44e3c`, migrations up to 057.

| Pillar | Existing tables and modules | In roadmap |
| --- | --- | --- |
| Execution | `project_structure`, `tasks` / `task_events`, `site_progress_items`, `time_bookings`, `employees` / `work_days`, `workforce_names` / `workforce_presence`, `deviations` / `deviation_links`, `cost_impacts` | weekly commitment cycle (implemented), measurement and value |
| Logistics | `purchase_orders` / `purchase_order_items`, `packages` / `package_items`, `shipments` / `shipment_receipts`, `assets` / `asset_positions`, `tools` | Site Materials & Inventory, QR identification |
| Assurance | `hse_events`, `hse_assets`, `hse_inspections`, `certifications` | quality and acceptance, handover, Permit to Work |
| Cross-cutting | `sites`, `places`, `users` / `sessions`, `site_members`, `member_module_access`, `attachments`, `audit_events`, `diary` / `diary_versions`, `signup_requests`, `invitations` | versioned document register, country modules |

The mapping shows that the three pillars already exist in practice. The vision makes them explicit, so that future choices are coherent instead of accidental.

## 5. Duplication points to prevent

These are not hypotheses: they are intersections already visible in the code or in approved specifications.

1. **`tools` vs `hse_assets`.** Logistics owns the identity of the equipment, Assurance manages its verifications and fitness through `tool_id`. This is the first concrete test of the model "one physical object, one identity". The same applies to installed assets, with the future `asset_id` in `hse_assets`.
2. **HSE inspection vs quality inspection.** `hse_inspections` exists, with templates and outcomes. Quality and acceptance (ITP, WIR, NCR) will use the same evidence mechanism. Two concepts of inspection, one engine: if this is not decided now, two parallel registers will be born that nobody will reconcile.
3. **Evidentiary diary.** It is a shared foundation, and it is receiving input from several sources: inventory sessions, handover, inspections. The risk is not its use, it is its abuse: becoming the container for everything and losing the evidentiary character that makes it useful.
4. **Places as warehouse locations.** Logistics will use `places` for depots, containers and shelves. If `places` grows to meet warehouse needs, the model changes for all three pillars, not just one.
5. **Attachments and document register.** `attachments` covers six entity types today and not assets and places; the versioned document register must not become a second attachment system alongside the first.
6. **Permissions per module or per pillar.** Today `logistics`, `workforce_names` and `workforce_presence` are strict: without an explicit grant they stay closed. The others are not. `materials` is not yet a module: it is a future requirement, not an active permission. The pillar view suggests reasoning per pillar; the current model is per module. This is an open decision, not a change to make now.

## 6. How to use this vision

- **Facing a new requirement**: establish the pillar, verify that it does not already exist in another, and only then design.
- **Facing an extension of a foundation**: assess the effect on the other two pillars before approving it.
- **Facing a module that looks duplicated**: do not merge out of enthusiasm. Merging two registers is more costly than their coexistence, if the coexistence is declared and linked.
- **Facing a proposal to reorganise the interface**: the vision does not impose it. The current navigation remains valid until there is an operational reason to change it.

## 7. What this vision is not

It is not a work plan, it is not a roadmap and it is not an authorisation. It does not provide for refactoring, renumbering, migrations or moving of modules. It does not change priorities: Places and Assets 2a and 2b remain ahead of everything.

Every initiative that arises from here goes through its own card, with scope, dependencies and the owner's authorisation.
