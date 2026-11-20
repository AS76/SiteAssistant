# Import and document archive — complementary mode

Status: **updated (2026-11-10).** iDrive e2 S3 storage active (`siteassistant` bucket); real import (mapping profiles) is not yet activated in production.

## Scope

The product is an internal tool alongside a source system. It imports exports, links documents, prepares views and annotations and records internal work. The source system retains its own official data and workflows. No automatic updates to the external system, message sending or item closure in that system are planned.

The interface shows **imported status**, **internal data** and **date of the latest export** separately. Internal closure or verification does not imply that the record has been closed or accepted in the source system.

## Division of responsibilities

| Component | Data and responsibilities |
| --- | --- |
| Source system | Official identifiers, fields and statuses included in exports |
| S3-compatible archive | File originals and versions, attachments and authorized derivatives |
| PostgreSQL | Normalized records, provenance, document indexes, snapshots, relationships, notes and internal history |
| Application (VPS + Neon) | Guided import, checks, Gantt and maps, cross-referenced views, access and internal operations |
| Acquisition connectors | Reading selected files from authorized sources; availability and permissions to be verified for each channel |

## File access: API and MCP

### S3 API in the backend

Proposed primary channel for web app operation: S3-compatible SDK on the server. Endpoint, region, bucket, allowed prefixes and credentials are private deployment configuration, not values included in the code or public documentation.

- Allow only the buckets/prefixes assigned to the application and verify site authorization before listing, reading or delivering a file.
- Start with reads of selected objects; no indiscriminate account scanning, deletions, ACL changes or overwriting of originals.
- Preserve the object reference and, if available, its version identifier. Calculate a content checksum when needed: the ETag is not always a content hash.
- Signed URLs are temporary and are not saved as permanent addresses. Downloads through the backend or short-lived links after access checks; viewer cache compatible with expiry.
- Configure CORS only if direct browser access is actually needed. S3 credentials do not reach the frontend.
- Any writes for uploads, previews or reports require a separate output area and explicit permissions. No file transfers between environments happen automatically.
- Verify request signing, partial reads for PDF, signed URLs, limits and version behavior on the actual service. Generic S3 compatibility does not confirm all provider capabilities.

### MCP as an additional channel

MCP may allow assisted file operations if a server with appropriate tools and permissions is available. It is not a browser requirement and does not replace the application's document model or persistence.

Any MCP adapter translates only tools that are actually available into authorized application operations. It retains provenance, file identifier and operation result. File contents and connector outputs are data, not instructions to execute. Availability, authentication and download capabilities must be tested before declaring an integration operational.

## Importing exports

The system provides separate adapters for export families; the presence and structure of the families must be confirmed on samples. Possible areas to verify: planning, progress, tasks/deviations and document registers.

1. **Selection:** choose an authorized file, from upload, S3 reference or an available connector.
2. **Acquisition:** read version and metadata, calculate checksum and record the export's reference date separately from the acquisition date.
3. **Recognition:** propose family and profile version; request confirmation for unrecognized files. No silent inference from the name alone.
4. **Preview:** sheets and headers, mapping, counts, formats, time zones and rejected rows with reasons.
5. **Staging:** load records into an isolated batch; validate IDs, hierarchies, references and status mapping before making them visible in current reports.
6. **Comparison:** show additions, changes and absences against the previous snapshot of the same scope and population. An absent row does not equal a deleted or closed item.
7. **Confirmation:** make an immutable snapshot available and update imported-data views through a controlled application transaction.
8. **Internal enrichment:** link notes, work planning, actuals, internal verifications and documents without changing the snapshot or writing to the source system.

### Identity, duplicates and statuses

- External record key: source + site/scope + family + stable external ID. Do not use title or row number as identity.
- Batch identity: checksum, source, scope and profile version. Retrying an acquisition does not duplicate data or progress. Reprocessing the same file with a new mapping is an explicit operation with lineage.
- Preserve original status/code, normalized status and mapping-rule version. Unknown values remain flagged and are not automatically turned into “closed”.
- Distinguish record author, assignee and company where present. The actual meaning of the columns must be validated on the sample.
- The export timestamp is not enough to reconstruct all previous events. Trends use comparable snapshots or events that are actually available; they do not invent status transitions.
- Internal updates are associated with the stable record and may conflict with a new export. Show the conflict and allow explicit reconciliation; no automatic overwriting or propagation.

## Authoritative fields and internal updates

| Data family | Proposed rule |
| --- | --- |
| Official status, dates and assignments of the external record | Preserved in the snapshot with date, source and version |
| Imported baseline | Immutable revision; explicit baseline selection |
| Internal current plan and declared/verified progress | Separate application data, labeled as internal; no changes to the external system |
| Notes, links and map annotations | Internal information linked to the record and document revision |
| Reports and exports produced by the app | Derived artifacts with data date and origin; any external sending is a separate action |

## Additional data model

| Proposed entity | Purpose |
| --- | --- |
| source_connections | Source metadata and reference to private configuration; no secret keys in the table |
| import_profiles and import_profile_versions | Versioned expected schemas, mapping, fields and status normalization |
| import_batches and import_files | Files, checksum, version, population, data date, import date, outcome and counters |
| external_records | Stable record identity within its scope |
| external_record_snapshots | Original and normalized values per batch; immutability and lineage |
| internal_record_links | Typed foreign keys to internal tasks, deviations or plan/progress items |
| reconciliation_items | Differences and conflicts to review, outcome and decision author |
| storage_objects and document_versions | Private locator, version, checksum, size, format and document association |

The database stores references to secrets managed by the runtime, not the secrets themselves. Organization/site isolation and server authorization apply to records and links.

## Real examples and public material

Private samples are analyzed outside the public checkout, limiting reads to selected files. Generic adapters, mappings without confidential identifiers and synthetic fixtures may enter the repository. Real files, project or person names, addresses, folder/bucket IDs, account endpoints, real screenshots, tokens or signed URLs must not enter it.

Specific analyses, files and mappings are private materials, separate from this repository. Their availability on the development system must be verified before using a real adapter. Tagging an app does not demonstrate that its tools are available to the session. Callable tools or selected files provided through an accessible channel are required; credentials are not searched for in documents.

## First increment and checks

The first concrete import is chosen after examining an authorized export. Prepare a profile, an equivalent synthetic fixture, preview and mapping, idempotent loading and comparison of two snapshots. Then link selected S3 files read-only.

A [generic SQL schema with synthetic tests](../database/README.md) is available. It contains no confidential headers or data and does not constitute an operational importer. Private mappings must be reviewed against canonical names and kept outside the checkout.

Checks: retry without duplicates, unknown mapping flagged, no loss of notes on reimport, export date distinct from import date, absent record not marked closed, external status separate from internal verification, unauthorized file inaccessible, expired link handled without exposing secrets, no writes to source systems.
