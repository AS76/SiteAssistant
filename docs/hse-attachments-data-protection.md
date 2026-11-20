# Attachments on HSE events — data protection rules

Status: design note, written **before** the code. It states what the product enforces, what the
customer decides, and where the line is. It is not legal advice.

## 1. Why a separate note

The health and safety register deliberately holds no health data: it records facts, places, measures
and a count of people. An attachment breaks that property if it shows an injured person, a face, or a
medical detail. A photograph of an accident scene is not automatically special-category data — but a
photograph that shows **who** was hurt, or **what** injury they suffered, is.

Two legal layers apply at once, and both are needed:

- a lawful basis under **Article 6** GDPR (for any personal data);
- a separate condition under **Article 9** if the image reveals health data. Without both, the
  processing is prohibited by default.

References are listed at the end.

## 2. Roles

- The **customer** (the company running the site) is the controller: it decides purpose, retention and
  who may look.
- The **supplier** of SiteAssistant is a processor for the data the customer puts in, and a controller
  only for its own account data. The processor acts on documented instructions; the product must make
  those instructions technically possible, not decide them.

Consequence for the product: anything that would require a legal judgement — how long to keep a photo,
whether a face may be visible — is **configuration the customer decides**, with a default that is safe
when nobody decides.

## 3. Product rules

**3.1 Prefer the scene, not the person.** The purpose of an attachment in this register is to document
a condition — a missing guard rail, an unmarked edge, a load that swung. The product must:

- keep the field description explicit: «photograph of the condition, not of the people»;
- warn, at upload time, when the file name or the declared description suggests a person or an injury;
- offer, in the interface, the option to attach a **diagram or pictogram** instead of a photograph.

**3.2 Faces are not allowed by default.** The safe default is no identifiable person. If a customer
needs to show a person, that is an explicit, logged choice with a written justification, not a
side effect.

**3.3 No health data, by design.** The product must not offer fields for diagnosis, injury type,
body part or days of absence. A photograph that shows an injury must be discouraged in the interface
and, if uploaded anyway, flagged as special-category content.

**3.4 Minimisation.** One attachment must be enough for the purpose. The product caps the number and
the size per event, and rejects files above the configured limit instead of silently compressing them.

**3.5 Retention.** Attachments inherit the event's retention rule. When an event is softly deleted,
its attachments stop being served immediately; hard deletion removes the object from storage. The
customer configures the retention period; the default is the shortest useful one.

**3.6 Access.** Attachments on an HSE event are visible to the same roles that can read the register
(owner, verifier) plus the roles that can write it (owner, editor). Reads and downloads are written to
the audit register — who looked at what, and when.

**3.7 No public links.** Objects are served through the authenticated API only. No signed URL that
outlives the session, no public bucket path.

## 4. What the product enforces, and what it cannot

| Rule | Enforced technically | Left to the customer |
| --- | --- | --- |
| Authenticated access, role check on every read | yes | — |
| Audit of reads and downloads | yes | reading the audit register |
| Soft delete hides attachments | yes | when to delete the event |
| Size, type and checksum validation | yes | — |
| Retention period | no | configuration decision |
| Faces visible in a photo | no (cannot detect reliably) | review before upload |
| Whether an image contains health data | no | judgement of the person uploading |
| DPIA necessity | no | assessment with their DPO |

The two rows that say «no» are the ones that matter: **the product cannot see a face or a diagnosis.**
Pretending otherwise with automatic detection would give a false sense of compliance — face detection
fails on profile views, masks, reflections, and does not address a visible injury at all.

## 5. When a DPIA is needed

Article 35 requires a data protection impact assessment where processing is likely to result in a high
risk. Indicators relevant here:

- systematic processing of **special-category data** (health) at scale;
- **systematic monitoring** of a workplace;
- processing of data about **vulnerable** people;
- **innovative technology** or new organisational use;
- data that could be used to **evaluate or score** people.

A site manager attaching one photograph of a missing guard rail is none of these. A company that
systematically photographs accident scenes with people in them, across many sites, probably is.
The product should therefore ask, once per customer, a short screening questionnaire and record the
answer next to the retention setting.

## 6. Technical checklist for the implementation

1. `attachments.entity_type` accepts `hse_event`, with the same checksum and size rules as the rest.
2. Module gate: the HSE module, not only the site role.
3. A deleted event hides its attachments in the same transaction that hides the event.
4. Every read of an attachment writes an audit event (`hse_attachment_read`).
5. Upload response carries a warning code when the description mentions a person or an injury.
6. Retention settings stored per site, with a safe default and a documented maximum.
7. Tests: role matrix, soft-delete propagation, audit trail, refusal above the size limit, refusal of
   forbidden mime types.

## 7. References

- GDPR Article 6 — lawful basis: <https://gdpr-text.com/read/article-6/>
- GDPR Article 9 — special categories, prohibition and conditions: <https://gdpr-text.com/read/article-9/>
- GDPR Article 35 — impact assessment: <https://gdpr-text.com/read/article-35/>
- Employer processing of photographs, consent versus legitimate interest: <https://www.gdprbelgium.be/en/news/can-employer-still-process-photos-under-gdpr>
- Legitimate interest in internal investigations: <https://www.osborneclarke.com/insights/gdpr-the-practical-impact-on-internal-investigations>
- Both a basis and an Article 9 condition are required: <https://www.gdprsummary.com/gdpr-sensitive-personal-data/>
- Pseudonymisation and minimisation as safeguards: <https://gdpr-text.com/read/article-9/>

These sources describe the general framework. They do not replace an opinion on a specific case, and
nothing in this note is legal advice.
