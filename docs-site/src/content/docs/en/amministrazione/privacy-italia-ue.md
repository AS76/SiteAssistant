---
title: Data protection in Italy and the European Union
description: EU GDPR and Italian data protection references for independent SiteAssistant installations.
---

> General background only: not a compliance certification, the employer's privacy notice or case-specific legal advice. The public demo is reserved for synthetic data.

## Legal framework

The principal EU framework is **Regulation (EU) 2016/679 (GDPR)**. In Italy, the **Legislative Decree 196/2003 (Italian Privacy Code)**, as amended, and sector- or employment-specific rules may also apply, including requirements linked to occupational health and safety.

Italy's supervisory authority is the **Garante per la protezione dei dati personali**. The applicable legislation follows the actual processing, not merely the language setting or the application's `jurisdiction: IT` value.

## Checks for a deploying organisation

| Topic | What to document |
| --- | --- |
| Principles (Article 5) | Defined purposes, minimisation, accuracy, limited retention and accountability. |
| Lawful basis (Article 6) | A basis for each purpose, including attendance, hours, task tracking and sharing with other organisations. |
| Special-category data (Article 9) | An additional condition and appropriate safeguards for health information. Do not assume an employee's consent is automatically freely given or appropriate. |
| Information and rights (Articles 12–22) | Appropriate notices, request-handling process and any justified limitations or exemptions. |
| Data protection by design and security (Articles 25, 32) | Access controls, attachments, backups, logs, offline devices and risk-appropriate measures. |
| Processors (Article 28) | Agreements and instructions where cloud or support suppliers process data on the organisation's behalf. |
| Records and DPIA (Articles 30, 35) | Assess records of processing activities and a DPIA where risk requires one. Do not presume exemptions apply. |
| Incidents (Articles 33–34) | Assessment, response and notification procedures where required. |
| International transfers (Chapter V) | Where data or remote access can reach parties outside the EEA and what safeguards are applicable. |

## Workers' data and fitness records

A training-expiry date is not the same as a medical record. However, information linked to a person about their occupational health fitness may be **health data**, even if it contains no diagnosis.

The Fitness module can hold medical-check categories, outcomes and notes. An organisation should assess with its DPO or adviser, and where appropriate its occupational physician, what information may lawfully be shared and with whom. Do not use free-text fields and photographs for unnecessary clinical details.

Workplace HSE obligations alone do not justify indiscriminate disclosure of workers' health information to clients or contractors.

## Relevant SiteAssistant limitations

SiteAssistant provides role- and module-based permissions but not a complete automated workflow for retention, erasure and person-specific access requests. Audit histories, backups and local browser copies require separate assessment. Complete the [deployment checklist](../privacy-checklist/) before real-data use; do not confuse soft deletion with total erasure.

## Official references

- [EU GDPR — EUR-Lex](https://eur-lex.europa.eu/eli/reg/2016/679/oj)
- [Italian Privacy Code — Normattiva](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2003-06-30;196)
- [Garante — principles of personal data processing (Italian)](https://www.garanteprivacy.it/web/guest/home/principi-fondamentali-del-trattamento)
- [Garante — workers' personal data, decision 26 March 2026 (Italian)](https://www.garanteprivacy.it/web/guest/home/docweb/-/docweb-display/docweb/10243180)
- [EDPB — data controller or processor](https://www.edpb.europa.eu/sme/learn-the-basics/data-controller-or-data-processor_en)

*Sources checked on 20 November 2026. Seek an updated local assessment before processing real data.*
