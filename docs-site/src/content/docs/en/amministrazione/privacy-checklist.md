---
title: Deployment privacy checklist
description: A verifiable readiness method distinguishing current SiteAssistant capabilities, configuration tasks and gaps before handling real data.
---

> **Not a certificate.** This checklist helps the organisation operating an installation evaluate its deployment. Completing it does not itself prove legal compliance. Do not upload real personal or confidential information to the public demo.

## Record each decision

For every control, document an **owner, result, evidence, date, corrective action and sign-off**. Suggested results: *verified*, *needs work*, *not applicable with justification*, *not verified*. The absence of a button in the application does not cancel a legal obligation.

## Before processing real data

| Area | Question to resolve | Evidence to retain |
| --- | --- | --- |
| Purposes and responsibilities | Who determines purposes? What are the roles of clients, principal contractors, subcontractors and suppliers? | Responsibility map and relevant agreements. |
| Applicable law | Which countries and processing activities are involved? Could more than one law apply? | Dated legal assessment and references. |
| Data inventory | What is stored in each module, free-text field, image or PDF? Who can be identified? | Inventory by category, source and recipient. |
| Lawful basis and transparency | What justifies each purpose? Are appropriate notices provided? Is an additional condition needed for health data? | Purposes/bases register and notices. |
| Data minimisation | Are names, clinical details and photographs necessary? Can a less detailed status suffice? | Module-specific data entry rules. |
| Access | Do site/module permissions match actual entitlements? Have external users and owners been tested? | Permission tests, including exports and attachments. |
| Hosting and services | Who operates database, object storage, email, geocoding, AI, reporting and backups? Which services are required for enabled functions? | Data flow diagram and supplier inventory. |
| Transfers | Can suppliers or administrators access data from other countries? | Regions, agreements, safeguards and documented assessment. |
| Retention | What periods and deletion methods apply to records, sessions, audit, attachments, exports, browser cache and backups? | Retention plan with executed, tested controls. |
| Individual rights | How are relevant records located, collected, corrected, restricted or erased, where applicable? | Request handling procedure and trial results. |
| Security and incidents | How are incidents detected, communicated and recovered from? | Incident plan, logs, backup and restore tests. |
| DPIA | Does the processing create risks requiring a data protection impact assessment? | Screening and DPIA where required. |
| Production approval | Does the actual installation match the approved design? | Signed go/no-go record with known limitations. |

## Current limitations that require explicit treatment

**Retention.** Certain imported payloads have documented retention settings, but the available housekeeping script is **not scheduled automatically**. The reviewed version has no general retention or deletion mechanism covering all application records, sessions, audit logs and backup copies. The deploying organisation must set and demonstrate its own operational retention controls.

**Invitations and permissions.** SiteAssistant records the recipient email, inviter identity, language, any proposed site and role, delivery results and invitation and permission audit events. The mail service receives the address and the single-use link, which expires after 72 hours. The database stores the hash. Expiry, revocation and use invalidate the link. Records and audit remain available after these events. Set retention periods for these records, email providers, logs and backups. This feature schedules no automatic deletion.

**Erasure and rights requests.** Some entities can be permanently deleted, some are only hidden while remaining in audit history, and others cannot be edited or deleted through normal application functions. There is no complete person-specific export or cross-system erasure workflow. Until such features are implemented and tested, appropriately authorised administration procedures and, where necessary, technical changes are required. Assess the applicable legal exceptions individually rather than promising automatic deletion.

**Offline devices.** Signing out clears the account’s offline copy, service worker data cache and queued changes. Offline sign-out clears local data immediately. Server session revocation is sent when the connection returns. Sync pending changes before signing out if you need to keep them.

**Health data and free text.** Fitness includes medical checks, outcomes and notes; files and free text in other modules can also identify people or disclose health information. Restrict or exclude such information until necessity, lawful basis, authorisations, retention and tested processes are in place.

**Permissions.** Four fixed roles and per-module controls are available, but a site's `owner` **is not restricted by module-access switches** and can access every module on that site. There are no field-level permissions. Review carefully who receives the `owner` role; technical visibility does not establish a legal right to access data.

**AI and external suppliers.** The AI assistant is not required for a basic installation. When enabled, it sends prompts and returned record data to its model provider; with `DEEPSEEK_API_KEY` and without `ASSISTANT_BASE_URL`, **DeepSeek** is the default endpoint. A different compatible endpoint can be configured. Disable it by removing the key from server configuration and restarting the service, **not** through a UI switch or separately by user or site. Assess the provider, data categories, purpose, international transfers and retention **before** using it with personal data. SMTP and object storage may involve third parties; address searches use **Nominatim** by default and may fall back to it after a Google Maps lookup.

**Exports.** Selected views offer CSV and browser print functions; a separate evidence-register CSV export (`GET /api/sites/{site_id}/evidence-export`) is also available within its data and module scope. None is a complete site-wide export or a person-specific export.

## Go/no-go decision

An installation can only be assessed against the **actual data and features in scope**. If a necessary personal-data control is missing, the organisation can limit the module or data, introduce a verified administrative/technical procedure, or postpone real-data use until the requirement is met.

Do not label a gap “compliant because it is the customer's responsibility”: an organisation's legal responsibilities do not make missing technical capabilities adequate by default.

## Related guides

- [Privacy and responsibilities](../privacy-responsabilita/)
- [Italy / EU](../privacy-italia-ue/)
- [United Kingdom](../privacy-uk/)
- [Data assistant](../../guida/assistente-ai/)

*Project methodology, 20 November 2026; baseline `9085a5d`. Seek jurisdiction-specific professional advice where needed.*
