---
title: Data protection in the United Kingdom
description: UK GDPR, Data Protection Act and DUAA references for independently deployed SiteAssistant installations.
---

> General guidance only, not UK compliance certification or legal advice. The public demo must only be used with synthetic, non-confidential data.

## Relevant UK law

The general UK framework includes the **UK GDPR**, **Data Protection Act 2018**, and the **Privacy and Electronic Communications Regulations (PECR)** where applicable. The **Data (Use and Access) Act 2025 (DUAA)** amends, but does not replace, the UK GDPR framework. ICO guidance updated on 19 June 2026 states that the DUAA data protection provisions are now in force.

The relevant supervisory authority is the **Information Commissioner's Office (ICO)**. English-language documentation, hosting in the UK or an application setting of `jurisdiction: UK` does not alone determine the applicable law. EU GDPR may also be relevant in some circumstances.

## Checks before real-data use

| Topic | Assessment for the organisation |
| --- | --- |
| Controllers and processors | Identify who determines purposes and means; consider clients, contractors, administrators and suppliers. |
| Lawful bases and transparency | Document purposes, lawful bases, privacy information and individual rights. |
| Workers' health information | Health data is special-category information; an appropriate condition and additional safeguards are needed. |
| Contracts and suppliers | Consider processor agreements where someone handles data on the organisation's behalf; a self-hosted code author is not automatically its processor. |
| International transfers | Identify suppliers, access and recipients outside the UK; assess applicable transfer rules and safeguards. |
| Retention and rights | Set retention and erasure procedures, including browser copies, audit logs and backups, and deal with individual requests. |
| Security, DPIA and incidents | Assess risk, test controls, carry out a DPIA where required and establish incident response and notification procedures. |

## Workers, fitness and construction sites

A Site Manager may need to know whether a worker can perform a task without needing diagnoses, medical reports or detailed health information. ICO guidance recommends collecting only necessary information, potentially limited to current or likely future fitness to work, and identifying the applicable condition for health-data processing. Employee consent should not automatically be relied on given the imbalance of power in employment relationships.

Photos, diary notes, incidents, attendance and time bookings can identify workers. `viewer` access in the application does not automatically authorise a client to see every worker's personal information.

## SiteAssistant limitations to assess

The reviewed version does not provide a general subject-access or erasure workflow, complete retention across all data categories, or field-level permissions. Real-data use may therefore require additional procedures, controls or software changes, particularly for attachments, backups, audit records and offline copies.

The AI assistant is optional, but if configured it sends prompts and record data to the chosen provider. Include this and any other enabled external services in the privacy assessment.

Complete the [deployment checklist](../privacy-checklist/) before processing real data. Software availability is not equivalent to a legal permission to process.

## Official sources

- [ICO — controllers and processors](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/controllers-and-processors/controllers-and-processors/what-are-controllers-and-processors/)
- [ICO — Data (Use and Access) Act 2025 for organisations](https://ico.org.uk/about-the-ico/what-we-do/legislation-we-cover/data-use-and-access-act-2025/the-data-use-and-access-act-2025-what-does-it-mean-for-organisations/)
- [ICO — workers' health information](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/information-about-workers-health/data-protection-and-workers-health-information/)
- [ICO — storage limitation](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-protection-principles/a-guide-to-the-data-protection-principles/storage-limitation/)
- [ICO — international transfers](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/international-transfers/a-guide-to-international-transfers/what-is-an-international-transfer-of-personal-information/)
- [Data Protection Act 2018 — legislation.gov.uk](https://www.legislation.gov.uk/ukpga/2018/12/contents)
- [Data (Use and Access) Act 2025 — legislation.gov.uk](https://www.legislation.gov.uk/ukpga/2025/18/contents)

*Sources checked on 20 November 2026. Official guidance may be updated; check before deployment.*
