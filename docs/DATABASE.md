# Database

PostgreSQL is accessed through Prisma. The schema is
[`packages/db/prisma/schema.prisma`](../packages/db/prisma/schema.prisma); the
generated client is re-exported by `@print/db`.

## Money and units

- Money is integer paise (₹1 = 100 paise).
- Slice statistics are per single unit; quantity is applied only by pricing.
- Issued quotations freeze the catalog/breakdown in `pricingSnapshot`.

## Models

| Model | Purpose |
| --- | --- |
| `UploadedModel` | Session-owned upload metadata and server-derived file paths. `submittedAt` is atomically claimed once during checkout to prevent replay. |
| `SliceResult` | Versioned/format-bound slice cache, progress, bounded slicer statistics, and error state. |
| `Quotation` | Number, status, denormalized customer PII, frozen pricing, PDF pointer, SHA-256 access verifier, and capability expiry. |
| `QuotationItem` | Issued line settings/prices and links to its model/slice. |
| `StatusHistory` | Status transitions and admin note. |
| `QuotationCounter` | Transactional per-year number sequence. |

Customer access tokens are never stored for new or migrated rows. `accessToken`
contains `sha256:<hex>` and `accessTokenExpiresAt` bounds verification to 30
days. The raw 256-bit capability is returned once to the browser.

## Slice cache identity

`SliceResult` remains unique on `(fileHash, settingsKey)`, but `settingsKey` is
the full artifact identity:

```text
<pipeline-version>:<format>:<material>:<layer-height-um>:<infill-pct>:<supports>
```

Format prevents valid cross-format/polyglot bytes from sharing a result.
Pipeline version invalidates results after Orca or machine/process/filament
profile changes. Colour and quantity remain excluded because they do not affect
toolpaths.

## Migrations and privileges

Development:

```bash
DATABASE_URL=postgresql://print:print@localhost:5433/print \
  pnpm --filter @print/db migrate:dev --name <change>
pnpm --filter @print/db generate
```

Production does not migrate from the web process. Compose runs the same image
in one-shot `migrate` mode with `MIGRATION_DATABASE_URL`, then provisions two
distinct runtime roles:

- web: application DML except `UploadedModel` insert and trusted slice-output
  columns; no schema/DDL privileges
- worker: model select/insert/update/delete, slice read/update, quotation
  read/delete, and quotation-item read grants only

Upload row creation belongs exclusively to the FIFO ingest consumer. Moving
`UploadedModel INSERT` from web to worker makes the single global consumer the
database-enforced session-limit fence; the privilege is moved, not duplicated.

Public database/schema creation is revoked. Web and worker start only after the
migration service exits successfully. Every deployment reapplies grants so a
new table is inaccessible until the provisioning allowlist is deliberately
updated.

```bash
docker compose run --rm migrate
```

Review SQL before deploying. The role-provisioning task refuses shared roles,
short/placeholder passwords, inherited roles, or runtime roles that own
database objects.

The generated Prisma engine target `debian-openssl-3.0.x` matches the Node 24
Debian web image and Ubuntu worker runtime.

## PII

Customer fields are denormalized on `Quotation`; there is no account/customer
table. The daily worker deletes terminal quotation rows, their cascaded items
and history, PDFs, and now-orphaned models after the
`QUOTATION_RETENTION_DAYS` threshold (90 days by default and at most).
Non-terminal quotations remain until the operator closes or cancels them.
Treat database dumps and any exports as sensitive PII.
