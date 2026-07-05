# Database

PostgreSQL via Prisma. The schema lives in
[`packages/db/prisma/schema.prisma`](../packages/db/prisma/schema.prisma); the
client is generated into `packages/db/generated/client` (git-ignored) and
re-exported from `@print/db`.

## Money & units

- **All money is integer paise** (₹1 = 100 paise). No floats.
- Slice statistics (`filamentGrams`, `printSeconds`, …) are **per single unit**;
  quantity is applied by the pricing engine, never stored pre-multiplied.

## Models

| Model | Purpose |
| --- | --- |
| `UploadedModel` | An uploaded file: session owner, `fileHash` (sha256), bbox, volume, `storedPath`, `thumbPath`. |
| `SliceResult` | Slice cache, unique on `(fileHash, settingsKey)`. Holds slicer weight/time/support, status, `rawMeta`, error fields. |
| `Quotation` | A submitted quote: unique `number`, denormalised customer fields, `pricingSnapshot` (audit), `accessToken`, status. |
| `QuotationItem` | One line: settings, quantity, per-line paise, per-unit grams/seconds, links to model + slice. |
| `StatusHistory` | Every status transition. |
| `QuotationCounter` | Per-year sequence for quotation numbers. |

Enums: `MaterialId` (PLA/PETG), `SupportMode` (AUTO/OFF/ALWAYS),
`QuotationStatus` (PENDING→…→DELIVERED/CANCELLED), `SliceStatus`.

## The cache key

`SliceResult` is unique on `(fileHash, settingsKey)` where
`settingsKey = "<material>:<layerHeightUm>:<infillPct>:<supports>"` — a readable
string (not a hash) that deliberately **excludes colour and quantity** because
they don't affect slicing. Identical files at identical settings reuse one slice
across sessions and duplicate uploads.

## Migrations

```bash
# development: create + apply a migration from schema changes
pnpm --filter @print/db migrate:dev --name <change>

# production: apply pending migrations (run automatically on web start-up)
pnpm --filter @print/db migrate:deploy
```

The web container's entrypoint runs `prisma migrate deploy` before booting, so a
`docker compose up` always lands on the latest schema.

## Regenerating the client

```bash
pnpm --filter @print/db generate
```

The client output path is set via `output` in the schema so the generated code +
query engine live inside the traced workspace — this is what makes Prisma work
reliably inside the Next.js standalone build. `binaryTargets` includes
`debian-openssl-3.0.x` to match the container runtime.

## Customer table (deferred)

There is intentionally no `Customer` table yet — customer fields are denormalised
onto `Quotation`. Promote to a table when accounts/repeat-customer features
arrive; nothing else needs to change until then.
