# Weekly commitment cycle

## 1. Problem and use cases

On Thursdays the coordinator reviews with the crews the impediments for the coming weeks and discusses the plan for the following week. Each crew confirms the result it commits to deliver, with a deadline and an observable criterion. During the current week, confirmations are recorded, the commitments kept are measured, and the remaining work is rescheduled while keeping a trace of the original promise.

**Verified state.** The schedule and the progress measures contain planned dates (`server/migrations/sqlite/036_wbs_operational.sql:17`, `server/migrations/sqlite/036_wbs_operational.sql:93`). Tasks have operational statuses and record reason, author and evidence in their transitions (`server/repository.mjs:20`, `server/repository.mjs:447`, `server/repository.mjs:498`). The closure check of a task also admits a motivated exception (`server/repository.mjs:474`). Within the examined scope, these functions do not define a crew promise, a frozen weekly plan or the PPC. The following rules are proposals, including the calendar of the meeting and of the publication.

## 2. Model

- **Lookahead.** Mobile view of the next 3–6 weeks starting from the following week, with candidate tasks, expected crew or company, execution window, readiness conditions and impediments to remove. Imported dates may feed the view, keeping provenance and snapshots. A candidacy may become an explicit proposal.
- **Current week.** Interval of operational days `[Monday, next Monday)` in the site's time zone and with its cutoff, already configurable (`server/migrations/sqlite/040_site_time_zone.sql:1`, `server/operational-day.mjs:34`). The coordinator publishes the plan discussed on Thursday after the confirmations, at the latest before the start of the week. Without publication the week is flagged as having no measurable plan. At publication, the calendar, the cohort and the original promises are fixed. The view distinguishes later outcomes and operational additions.
- **Commitment.** Immutable UUID, site, reference task, author of the proposal, person who takes the promise and account that records it, responsible crew or company, moment of taking, promised operational day, result, criterion and form of the required confirmation. The deadline is the opening cutoff of the following operational day, excluded. The date of the fact and the instant of recording are distinct. Team, company, applied calendar and criterion are readable historically from the respective revisions or snapshots. Each promise has one single operational owner: the crew if designated, otherwise the company.
- **Statuses.** `proposto` (proposed) becomes `preso` (taken) with attributed confirmation. From `preso` one moves to `mantenuto` (kept) with proof of result before the deadline, to `mancato` (missed) after the deadline with a cause, or to `annullato` (cancelled) with reason, actor and date. A withdrawn proposal may be cancelled while preserving the trail. Before consolidation, the absence of confirmation remains visible as an outcome to close. Closure atomically validates permission, status, site and proof. Motivated corrections create audited revisions, with validity end-excluded. Logical archiving, without ordinary physical deletion or loss of the historical outcome.

## 3. PPC

The denominator is the number of distinct UUIDs in the snapshot published for the week, confirmed as taken at the moment of publication and with a deadline within the week. Before publication, proposals, withdrawals and cancellations are excluded. After publication the cohort stays fixed, even if a commitment is cancelled with a reason, moved, archived or the task changes its date. A cancellation after publication counts in the denominator and is worth zero in the numerator. The number of these cancellations is shown with their reason. Promises added during the week can be managed and closed, with separate counts.

The numerator is the number, within the same cohort, of commitments closed as kept with admissible confirmation, which attests the entire original result before the original deadline. Work finished late is worth zero even if verified later. A confirmation recorded after the deadline may prove a fact that happened in time. A commitment moved after freezing receives a new UUID linked to the previous one. The original keeps its outcome, and the new one enters only its own cohort if it meets the publication criteria. The same fact may document several distinct results already defined in the plan, without duplicating the same delivery.

PPC = 100 × numerator / denominator. With a zero denominator, show «not applicable» (non applicabile) with counts 0/0. During the week, show provisional PPC and the number of open outcomes, with the same denominator. Consolidate after the end of the week, when every outcome is decided. In the absence of an eligible confirmation, the verifier records `mancato` (missed) with the cause «insufficient confirmation» (riscontro insufficiente). A valid confirmation arriving after consolidation requires a motivated correction and a new version of the PPC. Keep the date, author, values and cohort of every version.

The minimum unit is a verifiable delivery attributed to a crew or company, with a single binary outcome and weight one. A quantity may be part of the criterion, without fractions of a vote. The series reports week, version, fraction, percentage and outcomes per historical crew and per site. Commitments attributed directly to companies flow into the site total and are visible as such. Aggregates are computed from counts, avoiding averages of percentages. Example: 3 kept out of 5 for one crew and 1 out of 1 for another give 4/6 for the site.

## 4. Causes of non-fulfilment

Proposed catalogue with stable codes and IT/EN labels: incomplete predecessor, materials, equipment, crew availability, access or permit, decision or technical information, interference, environmental conditions, change of priority, insufficient confirmation, cause to be determined, other. The last value requires a note. Catalogue revisions preserve historical outcomes. The crew proposes the cause, and the designated verifier or the owner records it at closure, with source and justification for any corrections. Analysis of recurrences guides the removal of impediments and may generate actions with an owner and a deadline. No personal scoring or automatic attribution of blame.

## 5. Links

- Internal task with UUID and optional reference to the stable planning source. Imports and renewals of the plan preserve the promise and the confirmation. Task closures and percentage, quantitative or binary measures have their own cycle.
- [Diary and evidence](evidentiary-diary.md). Link the entry or revision with the dated fact, a relevant attachment, or a structured and attributed confirmation from the verifier. The reference must satisfy the agreed criterion and be consultable according to the permissions of the source.
- Impediments. Link a blocking event or a diary entry with a contact person, an action and the expected removal date. If a dedicated register is needed, define it separately. A resolved impediment may make a proposal ready.
- [People, crews and companies](people-and-companies.md) and [places and assets](places-and-assets.md). Apply stable identities, the site perimeter and the snapshots relevant to the date of the promise or of the fact. If a stable key is missing, keep the original value and require explicit reconciliation.

## 6. Permissions

The editor with access to the module proposes and coordinates. An authorised representative of the crew or company takes the commitment. An editor may transcribe the confirmation of a person without an account, keeping who confirmed, the source and who recorded it. The owner or the editor with publication delegation freezes the plan. The owner or the designated verifier closes and records the causes, with separation between who confirms or declares execution and who verifies it. Consolidated corrections are reserved to the owner, with justification. Reads follow site, membership and module authorisations, including confirmations, counts and exports. The current edit/review roles include demo_user (`server/repository.mjs:90`), while named modules have explicit checks (`server/module-access.mjs:9`).

The demo_user sees synthetic plans, confirmations and PPC only in the demo sites and tests the flow with simulated roles. In the initial release, lightweight access follows the perimeter of the people and companies specification. On a shared task it exposes only the fields published for that task and allows any authorised contributions. The weekly plan, internal causes, aggregates and official actions remain reserved to authorised internal sessions.

## 7. Acceptance criteria and negative tests

| Scenario | Expected result |
| --- | --- |
| Thursday, lookahead with impediment and confirmation for the following week | Publication freezes criterion, crew and date. A change in the import leaves the cohort unchanged. |
| Double closure, including concurrent | A single transition and one effect on the PPC. Replay with the same key returns the original outcome; a second, distinct transition receives a conflict. |
| Kept without proof, with foreign proof, or with completion after the excluded cutoff | Closure rejected. The kept outcome is admitted only with eligible, attributed and timely proof. |
| Zero denominator | PPC not applicable, 0/0, in UI and export. |
| Cancellation before and after publication, move beyond the week | Cancellation or move after publication leaves the original in the cohort with zero in the numerator. The successor is evaluated in its own week. |
| Commitment on a task of another site, including with double membership | Request rejected, no link or aggregate effect. |
| Change of crew, DST, proof recorded after closure of the series | Historical series anchored to the original crew and calendar. Explicit correction to update a consolidated version. |
| Demo and external link, in IT and UK UIs | Same calculation criteria and same controls. No disclosure of reserved annotations or counts. |

## 8. Risks, out of scope, owner decisions

Splitting deliveries, postponing decisions or freezing the plan late can distort the reading of the PPC. Show cohort, counts and variations next to the percentage. Out of scope: rewriting external planning, automatic resource optimisation, weighting by value or hours, penalties and individual evaluations.

The owner must approve the day of the meeting and of the publication, the horizon from 3 to 6 weeks, the proposed rule on cancellations, thresholds and consolidation responsibilities, the proofs admitted per type of delivery, delegations and the catalogue of causes. Week boundaries and the formula have IT/UK parity, except for future explicitly versioned variants visible in the series.
