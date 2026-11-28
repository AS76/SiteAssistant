# Country modules and content language

## 1. Problem and use cases

An Italian site and a British site must use the same flows for diary, HSE, planning and reports, with documents, safety roles and calendars appropriate to the site. An operator may use the English interface on an Italian site, import quantities in their source units, or attach evidence written in another language.

**Verified state.** The site jurisdiction already exists and accepts IT and UK, with IT as the default also in the migrations (`server/migrations/sqlite/028_site_jurisdiction.sql:1`, `server/migrations/pg/028_site_jurisdiction.sql:1`, `server/repository.mjs:153`, `server/repository.mjs:179`). The time zone and cutoff are configured per site (`server/migrations/sqlite/040_site_time_zone.sql:1`). HSE checklists already include distinct templates per jurisdiction, exposed by the server (`server/checklists.mjs:3`, `server/checklists.mjs:54`, `server/http.mjs:560`). The units on order and package lines are text (`server/migrations/sqlite/032_purchase_orders.sql:22`, `server/migrations/sqlite/033_packages.sql:20`). Certifications use generic operational categories (`server/certifications.mjs:7`). The currency preference is for display only and lives in the browser (`app/app.mjs:15`, `app/app.mjs:29`). The interface has an IT/EN catalogue and formats tied to the language. The English date module uses month/day, while some labels use en-GB (`app/i18n.mjs:1`, `app/domain.mjs:111`, `app/domain.mjs:116`, `app/app.mjs:133`). The diary text has its own fields, and the base record has no language declaration (`server/migrations/sqlite/001_init.sql:37`, `server/repository.mjs:573`). Within the verified scope, country support is therefore partial. Calendars, document requirements and content language require the model proposed here.

## 2. Model

The `jurisdictions` catalogue stores a stable `code`, a `country_code`, an optional `territory_code` and labels in Italian (`label_it`) and English (`label_en`). Migration 058 seeds the following entries.

| Code | Country | Territory | Italian label | English label |
| --- | --- | --- | --- | --- |
| `IT` | `IT` | — | Italia | Italy |
| `UK` | `UK` | — | Regno Unito · territorio da confermare | United Kingdom · territory to confirm |
| `UK-GB` | `UK` | `GB` | Gran Bretagna | Great Britain |
| `UK-NI` | `UK` | `NI` | Irlanda del Nord | Northern Ireland |

`UK` leaves the territory unassigned. The site retains that code until an explicit choice of `UK-GB` or `UK-NI` records the territory on the basis of evidence or approval. The site API accepts exact catalogue codes and explicitly rejects unsupported values with HTTP 400, without aliasing or inference from language.

`sites.jurisdiction_code` is a nullable reference to the catalogue. `sites.content_language` stores the site's declared content language (`it`, `en`, or null for “not declared”). These are additive columns alongside the historical `sites.jurisdiction`. The interface language selects the labels displayed to the user. The operational jurisdiction, site content language and time zone are configured independently of that preference.

The broader country-module proposal covers the following data and configuration.

| Recorded data | Declarative configuration |
| --- | --- |
| Site, country, optional territory, time zone, cutoff and source of the declaration | Versioned register of supported modules and territories, suggested values and generic validation rules |
| Document, revision, declared language, author, data and original attachments | Templates by type, country, territory and language, mandatory fields, applicability rules and labels |
| Appointment or evidence referring to a person or company, period and provenance | Catalogue of roles and documents, permitted relationships, conditions, official references and approval status |
| Amounts and currency, value and unit, raw data, effective site calendar | Accepted formats, unit vocabulary, currencies permitted per field, territorial calendar and operational suggestions |

Every module has a stable ID, an immutable revision and a validity interval with the start included and the end excluded. The same applies to assignments, appointments and site configurations that take effect over time. Use logical archiving and preserve historical and original references without ordinary physical deletion. The published document keeps the revision of the module and of the model, the rules applied, the language and the references to the sources. A future change applies from its effective date and preserves the reproducibility of earlier editions.

The proposed documentary rules resolve through site, territory and reference date. The proposal envisages declaring the language of individual documents at entry or import, including more specific tags where the catalogue supports them. A pre-filled choice requires confirmation. The links to the [diary](evidentiary-diary.md), [people and companies](people-and-companies.md) and [places and assets](places-and-assets.md) use UUIDs, validity and the site perimeter.

## 3. Localised content

- UI in IT/EN, selectable per profile. The UI language changes the labels, while the language of a text remains the author's declaration. Missing labels may have a fallback that is explicitly configured for the UI only. For a required document template, the absence of the selected language blocks generation and indicates the gap.
- Templates and glossaries with stable keys and reviewed translations. A translation is a revision or variant linked to the original, with language, author and provenance. Quotations and attachments keep the original with an indication of its language when available. A bilingual document requires an explicitly enabled template and blocks with a declared language.
- Canonical civil dates `YYYY-MM-DD` and instants with an explicit offset or UTC, keeping the original provenance and timestamps. Proposed operational formats for IT and UK: day/month/year, with calendar validation. The proposed numeric formats are `1.234,50` for IT and `1,234.50` for UK. A module or import profile must declare the format before interpreting an ambiguous value. No second attempt with a different format.
- Canonical amounts with decimal and explicit currency code. EUR and GBP are suggestions for IT and UK respectively, to be confirmed where the field requires them. Changing the preference alters the display, preserving the recorded amount and currency. Quantity with a stable unit code and original value. Unknown units remain to be reconciled. Any explicit conversions keep the source value, the factor and the target unit.
- Site calendar made up of territory, holidays with source, timetables/shifts, local exceptions, time zone and cutoff. A holiday may be overridden in the operational calendar with audit. Holidays and shifts are explicit local dates or intervals, independent of the chosen language.

## 4. Legal and documentary requirements IT/UK

This product specification does not constitute legal advice. The references identify elements to be represented. Roles, applicability, signatures, obligations, retention, calendars and texts require validation by the HSE lead and by legal counsel competent for the territory before operational use.

| Aspect | IT | UK |
| --- | --- | --- |
| Roles and appointments | Represent the client, the works manager and the design/execution coordinators with appointment, period and party | Represent the client, principal designer, principal contractor and other parties applicable in the territorial profile |
| Files, plans and responsibilities | Distinct types for PSC, POS and the construction file (fascicolo dell'opera), with site or company level and configured applicability | Distinct types for pre-construction information, construction phase plan and health and safety file, each with owner, phase and applicability |
| Traceability | Manage source, revision, responsible parties, status and evidence of delivery, approval or notification where relevant | Same level of traceability. Distinct profiles for Great Britain and Northern Ireland, and a territory-specific calendar |
| Calendar and operational documents | Holidays and shifts approved for the site, IT vocabulary and templates with availability of the planned translations | Distinct calendars for England/Wales, Scotland and Northern Ireland, shifts approved for the site and UK templates with availability of the planned translations |

Document types and roles have their own identities per regime. Operational analogies serve navigation. For applicable obligations, represent conditions such as phase, type of work or presence of several companies, and record the human assessment with its source. The starting sources are [D.Lgs. 81/2008, art. 89](https://www.normattiva.it/atto/caricaDettaglioAtto?atto.articolo.numero=89&atto.articolo.sottoArticolo=1&atto.articolo.tipoArticolo=0&atto.codiceRedazionale=008G0104&atto.dataPubblicazioneGazzetta=2008-04-30), the [HSE guidance to CDM 2015](https://www.hse.gov.uk/pubns/priced/l153.pdf), the [HSENI framework for CDM 2016](https://www.hseni.gov.uk/articles/construction-design-and-management-regulations-northern-ireland-2016) and the [GOV.UK calendars](https://www.gov.uk/bank-holidays).

## 5. Extensibility to a third country

The register must allow the addition of a country code and territories, locale, calendars, currencies and units, roles, vocabulary, templates, applicability rules and sources through a declarative package that is validated and versioned. The functional modules consume a common schema with known types, conditions and operations. Loading validates references, overlapping intervals, keys and dependencies before activation. No executable code in the packages. Adding a country within the capabilities already represented requires only the package and its activation. New product capabilities may require a common extension of the contract. The proposal assumes an initial adjustment of the current validation and of the IT/UK constraint.

## 6. Migration

1. Migration 058 creates and seeds the catalogue and adds the two nullable site columns in SQLite and PostgreSQL. Existing rows keep their historical `jurisdiction`, time zone and cutoff, with both new columns initially null. Diary records are untouched.
2. When `jurisdiction_code` is null, the API exposes the historical value as `jurisdiction` with `jurisdiction_declared: false`. This includes `IT` values originating from the historical default. A historical `UK` still has its territory to confirm. A null `content_language` is displayed as “Not declared” in the English site settings.
3. The new-site form requires an explicit jurisdiction choice. An API create request that omits jurisdiction leaves the declaration empty and exposes the historical `IT` default. A site owner can declare the jurisdiction in site settings. The update is audited and writes the chosen code to `jurisdiction_code`, preserving the historical column.

## 7. Acceptance criteria and negative tests

| Scenario | Expected result |
| --- | --- |
| English UI, IT site, document in Italian | The IT profile applies with the document's declared language. Changing the UI preserves result, content and metadata. Also applies to Italian UI and UK site. |
| New content without declared language | Publication rejected with indication of the field. Historical export allowed with explicit provenance status. |
| Required country or territory module missing | Publication dependent on the profile blocked with explicit error. Historical reading keeps its own references. |
| Impossible date, number in a foreign format, unknown unit or currency | Validation fails, or import goes to reconciliation with the original preserved. The same valid date keeps its meaning in both UIs. |
| IT template with a UK normative field in the same document | Publication rejected. An English translation of the IT document, or a UK quotation marked as an attachment, is allowed within the rules of the template. |
| Module updated or archived | The document already issued remains reproducible with the original revision. The new generation uses the effective revision. |
| Third country and concurrent insertion of revisions | The valid package is activated through the common register. Incompatible or overlapping revisions are rejected without partial activation. |

## 8. Risks, out of scope, owner decisions

Main risks: historical defaults mistaken for declarations, regulatory drift, import ambiguity and translations that alter the technical vocabulary. Out of scope: automatic legal advice or attestation of compliance, machine translation with official value, submissions to authorities, automatic currency conversion, payroll rules and full contractual calendars.

The owner must define the territories of the first release and their validators, the priority documents and the minimum data for each type, the publishable languages, the calendar exceptions, who may declare or correct country and language, and the handling of the legacy data with uncertain provenance. IT and UK must have equal capability for review, traceability and publication once their respective modules are validated.
