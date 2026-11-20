# Increment 8 — Attachments

Implemented in the backend: attachments to `task`, `diary` and `site`, authorization through session and membership, S3 SigV4 client with no additional dependencies, SHA-256 readback and streaming downloads through the API. The graphical interface for attachments is not part of this increment.

Migration `007_attachments.sql` is available for PostgreSQL and SQLite and is discovered by the existing runner. It has not been applied to an operational database. No service, bucket, credential or deployment was configured by this increment.

## Runtime configuration

Provide `S3_ENDPOINT` (HTTPS), `S3_BUCKET`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` in the server environment. No real values must be saved in the repository. The client uses path-style requests; the default signing region is `us-east-1`, with an optional `S3_REGION` override when required by the endpoint. Without configuration, file operations return `503 STORAGE_NOT_CONFIGURED`; the rest of the API continues to work.

The bucket must be private and have SSE enabled. The client inherits the encryption configured on the bucket, with no client-side encryption or policy changes. SSE configuration and operation on the real provider require verification in the operational environment: tests do not access S3.

## API

| Method and path | Access | Result |
| --- | --- | --- |
| `POST /api/attachments` | Entity owner/editor | `201`, new attachment metadata |
| `GET /api/attachments?site_id=…&entity_type=…&entity_id=…` | Site member | `200`, metadata array |
| `GET /api/attachments/:id` | Site member | `200`, streaming bytes |
| `DELETE /api/attachments/:id` | Owner/editor | `204` |

POST accepts a JSON object with `entity_type`, `entity_id`, `filename`, `content_type` and `data_base64`. Entirely synthetic example (replace the UUID with an existing test entity):

```json
{
  "entity_type": "diary",
  "entity_id": "00000000-0000-4000-8000-000000000001",
  "filename": "synthetic.pdf",
  "content_type": "application/pdf",
  "data_base64": "JVBERiBzeW50aGV0aWM="
}
```

The site is derived from the entity; any explicit `site_id` must match. Missing entities/malformed IDs produce `400`; cross-site links or insufficient roles produce `403`. For lists, `site_id` is required, `entity_type` is optional; filtering by `entity_id` also requires `entity_type`. Returned metadata includes size, hexadecimal SHA-256, author, timestamp and `manifest_version: "v1"`, without storage locators, endpoints or access URLs.

The decoded maximum is 15 MiB (15 × 1024 × 1024 bytes), with canonical, non-empty base64. The dedicated JSON limit allows base64 expansion plus 64 KiB of overhead; other routes retain the 64 KiB limit. Excessive size: `413`; MIME other than `image/*` or `application/pdf`: `415`. The MIME check concerns the declared type; it is not an antivirus or a format parser. The name must be valid, within 255 UTF-8 bytes and without paths or control characters.

Downloads are forced as attachments with a UTF-8 name, `nosniff`, CSP sandbox and `Cache-Control: no-store`. No public or signed URLs are generated. Reads are authenticated before contacting storage; an error during streaming terminates the response without adding JSON to the file bytes.

## Integrity and error handling

Each upload creates a distinct random key, with `If-None-Match: *`; there is no route to overwrite files. The manifest version is `v1`, independent of native bucket versioning.

Sequence: local SHA-256 → PUT with checksum in metadata → HEAD comparing checksum and size → GET recalculating SHA-256 on the bytes → entity/permission recheck and transactional INSERT. The additional GET prevents a mere metadata echo from being considered proof of integrity; ETag is not interpreted as SHA-256. A mismatch produces `502 ATTACHMENT_CHECKSUM_MISMATCH` without inserting a row.

After a confirmed PUT, readback or INSERT errors trigger a compensating DELETE attempt. If cleanup also fails, `503 ATTACHMENT_CLEANUP_FAILED` is returned. For deletion, a storage error rolls back the SQL transaction, keeping the metadata for a retry; DELETE on storage is idempotent.

SQL and S3 do not share a distributed transaction. A crash, a PUT with an uncertain network outcome or a commit error after DELETE may require operational reconciliation between keys and rows. Automatic orphan cleanup is not implemented; do not reset the seed with attachments present. Tests cover compensable errors, without simulating an atomicity guarantee between the two services.

## Checks

`npm test` includes the `attachments`, `attachments-schema` and `s3` suites through `tests/index.js`. In-memory storage implements `put/get/head/delete`; the real client is verified with injected transport and independently calculated synthetic SigV4 vectors. No new suite uses a network or real credentials. SQLite and in-memory PostgreSQL verify upgrade from `006`, physical types, constraints, index, replay and repository operations.

Protocol references: [AWS SigV4 signing](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html) and [provider's S3-compatible APIs](https://www.idrive.com/s3-storage-e2/s3-compatible-api).
