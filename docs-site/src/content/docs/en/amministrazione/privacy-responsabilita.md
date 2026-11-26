---
title: Privacy and deployment responsibilities
description: Independent deployment, responsibility for personal data, and the current privacy-related capabilities of SiteAssistant.
---

> **Scope.** SiteAssistant is free and open-source software distributed for independent deployment. This page is not the deploying organisation's privacy notice, a compliance certification, or legal advice. **Use the public demo only with synthetic, non-confidential data.**

## Software that can be deployed in different countries

SiteAssistant can be downloaded, deployed and adapted under its [AGPL-3.0-only licence](https://github.com/AS76/SiteAssistant/blob/main/LICENSE). Its ordinary distribution model is not a centrally hosted SaaS service operated by the author on behalf of all adopting organisations.

Each deploying organisation must identify the laws applicable to its **actual processing**, assess the chosen infrastructure and suppliers, determine purposes and access permissions, and put appropriate safeguards in place **before** processing real personal data. The availability of the software and its open-source licence do not themselves provide a lawful basis.

The interface language (**IT/EN**), server location and application `jurisdiction` field **do not alone determine** which law applies. In the reviewed version the field supports only `IT` and `UK` for certain application functions. This is neither a legal certification nor a general jurisdiction engine. Organisations in other countries must determine which functions need adapting.

## Who decides what happens to the data?

| Situation | Responsibility to assess |
| --- | --- |
| An organisation independently installs SiteAssistant and determines why and how personal data is used | It will normally act as a **controller** for those purposes, subject to its arrangements with others. |
| Clients, principal contractors and subcontractors participating in a project | They may act as separate controllers, joint controllers or in other capacities. Application role names do not determine legal roles. |
| A hosting provider, external administrator or support business processing data on another organisation's behalf | It may act as a **processor**, requiring appropriate instructions and agreements where the law demands them. |
| An author distributing code without receiving or processing personal data from independent deployments | The author is **not automatically a processor** of those deployments' data. |
| Someone operating the public demo or providing a separate hosted or data-accessing service | Responsibilities must be assessed **for that activity**, separately from code distribution. |

The legal position follows the activities performed, not merely the wording of a contract, an `owner` role in the app, or the software licence.

## What information can SiteAssistant contain?

- **People and work:** accounts, names, contractors, roles, attendance, hours, assignments, action history and identifiers of people performing actions.
- **Invitations:** recipient email, inviter identity, language, any proposed site and role, delivery results and audit records. The database stores a token hash. The link expires after 72 hours, while the invitation and audit records follow the deployment's retention policy.
- **Site records:** tasks, diary, WBS, progress, deviations, HSE, cost impacts and reports. Free-text fields may contain personal data even where that is not their intended purpose.
- **Potential health information:** certifications, medical checks, fitness outcomes, notes or photographs revealing health conditions. Even a concise fitness-to-work outcome may require special safeguards.
- **Copies and metadata:** attachments, exports, backups, information stored by the browser and queued offline operations. Session records also retain IP address, user-agent and authentication metadata; audit records may include the actor, timestamp, previous and updated values of changed or deleted records, and access to HSE attachments. The PWA's offline copies include lists and attachment metadata, **not** the attached binary files.

Collect only what is necessary. Avoid diagnoses, medical reports or unnecessary clinical detail in operational notes.

The demo access log and the other entries documented by the project are in the [record of processing activities](../inventario-trattamenti/).

## Where does the data go in an independent installation?

The application uses **SQLite by default** or optional PostgreSQL. The reviewed version does not require an author-operated central backend or send automatic telemetry or analytics to the project. **That does not make every feature local-only.**

| Component | Current behaviour to consider |
| --- | --- |
| Database | Stored in the organisation's configured SQLite or PostgreSQL environment. |
| Attachments | Require configured S3-compatible object storage; the reviewed version has no automatic on-disk fallback. |
| Email | Account requests, password recovery and invitations use the configured mail service. Invitation emails give that service the recipient address and the single-use link. |
| AI assistant | Optional: without a provider key it does not respond. When enabled, it sends questions and query results to a model service. With `DEEPSEEK_API_KEY` set and `ASSISTANT_BASE_URL` unset, the default endpoint is **DeepSeek**. A compatible endpoint, including a self-hosted one, can be configured. Disable the assistant by removing the provider key from server configuration and restarting the service; no UI, per-user or per-site toggle exists. |
| Address search | When used, it queries the public **Nominatim** geocoding service (using OpenStreetMap data) by default. With `GOOGLE_MAPS_API_KEY` it tries Google Maps, but may fall back to Nominatim if Google returns no results or fails. The reviewed version has no dedicated application switch to disable all external address lookups. |
| Reporting | May use an optional separate reporting database. |
| Offline use | Signing out clears the account’s offline copy, service worker data cache and queued changes. Offline sign-out clears local data immediately. Server session revocation is sent when the connection returns. Sync pending changes before signing out if you need to keep them. |

The deploying organisation must identify the suppliers it actually uses, their locations, contractual protections, access arrangements and possible international transfers. The public demo's infrastructure is **not** a required configuration for other installations.

## Product capabilities are not legal compliance

Per-site roles and per-module access are useful technical controls. They do **not** replace the organisation's determination of who may lawfully view each category of information. An `owner` can access **every module on their site** regardless of module-access switches; those switches do not restrict an owner. The reviewed version has no field-level permissions and no complete workflow for handling individuals' data protection requests.

Deleting a visible record does not necessarily remove the same information from histories, audit logs, exports, backups or devices. **There is not currently a comprehensive automatic retention, personal-data erasure or person-specific export facility.** Where such capabilities are needed, the organisation must implement and test appropriate procedures or technical changes, or limit the data it processes until the requirements are met.

Use the [deployment checklist](../privacy-checklist/) to distinguish existing controls from decisions and outstanding work.

## Jurisdiction references

- [Italy and the European Union](../privacy-italia-ue/): EU GDPR and Italian context.
- [United Kingdom](../privacy-uk/): UK GDPR and UK context.
- **Other jurisdictions:** obtain an appropriate local assessment; documentation in English does not imply UK law applies.

## General sources

- [EU GDPR — official text](https://eur-lex.europa.eu/eli/reg/2016/679/oj)
- [EDPB — data controller or processor](https://www.edpb.europa.eu/sme/learn-the-basics/data-controller-or-data-processor_en)
- [ICO — controllers and processors](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/controllers-and-processors/controllers-and-processors/what-are-controllers-and-processors/)

*Guidance reviewed on 20 November 2026. Technical baseline: commit `9085a5d`. Recheck actual product behaviour after significant software changes.*
