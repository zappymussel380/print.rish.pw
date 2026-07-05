# Architecture

## Overview

Two application containers share a pnpm workspace:

- **web** (`apps/web`) — Next.js 15. Serves the UI and all API route handlers.
- **worker** (`apps/worker`) — a BullMQ consumer that runs OrcaSlicer, renders
  thumbnails, and performs the daily retention sweep.

They share three workspace packages:

- **`@print/db`** — the Prisma schema and a `PrismaClient` singleton.
- **`@print/shared`** — the pricing engine, the product catalog, zod schemas,
  the settings key, the WhatsApp/order-summary builders, money/format helpers.
- **`@print/geometry`** — a dependency-light parser for STL/3MF/OBJ/AMF that
  returns a triangle soup, bounding box and volume (no three.js in Node).

Backing services: **PostgreSQL** (Prisma) and **Redis** (BullMQ queue, slice
cache coordination, sliding-window rate limits, worker heartbeat).

```
          ┌────────── VPS host nginx (print.rish.pw, TLS) ──────────┐
          │                    │ Tailscale                          │
          ▼                    ▼                                     │
     ┌─────────┐  8080   ┌──────────┐   ┌──────────┐                │
     │  proxy  │────────▶│   web    │──▶│ postgres │                │
     │ (nginx) │         │ (Next)   │   └──────────┘                │
     └─────────┘         │          │──▶┌──────────┐  ◀── worker ───┘
                         └──────────┘   │  redis   │
                              ▲         └──────────┘        ▲
                              │              ▲              │
                              └── uploads ───┴── slice jobs ┘
                                   volume        (BullMQ)
```

Only the **proxy** publishes a port. The VPS host nginx terminates TLS for
`print.rish.pw` and proxies to the compose proxy over Tailscale — see
[DEPLOYMENT.md](DEPLOYMENT.md).

## Request flows

### Upload
`POST /api/uploads` streams the multipart body through busboy straight to disk
under `UPLOAD_DIR/<uuid>.<ext>`, hashing (sha256) as it flows. The file is then
parsed by `@print/geometry` — a successful parse is a far stronger validity
check than magic bytes — and checked against the printer bed. A row is written
to `UploadedModel`, scoped to an anonymous, signed `qsid` session cookie.

### Slice + live pricing
The quote page requests a slice per model+settings via `POST /api/slices`:

1. Cache key = `sha256(file)` (`fileHash`) + `settingsKey`
   (`material:layerHeightUm:infillPct:supports` — colour/quantity excluded).
2. Hit on `SliceResult` → returned immediately. Miss → a `SliceResult` row is
   created and a BullMQ job enqueued with a deterministic `jobId` (natural
   dedup of identical in-flight requests). The client polls
   `GET /api/slices/:id` every 1.5 s.
3. The worker writes a per-job process profile (flattened base + infill/support
   overrides), runs OrcaSlicer headless under `xvfb-run`, parses
   `Metadata/slice_info.config` from the exported 3MF for weight/time, renders a
   thumbnail from the parsed mesh, and updates the row.

Pricing is a **pure, isomorphic** function (`@print/shared/pricing`). The client
reprices instantly from cached slice results; the server reprices
authoritatively at checkout — client totals are never trusted.

### Checkout
`POST /api/quotations` rebuilds every line from DB slice results, reprices,
allocates a number (`RSP-<year>-<seq>` via a transactional counter), persists
the quotation + items + status history, renders the PDF, and returns a WhatsApp
handoff URL + a token-guarded confirmation link.

## Design decisions

- **No mathematical estimation.** Every price is backed by real toolpaths. This
  is the whole point, and dictates the async worker + cache design.
- **Readable settings key, not a hash.** `PLA:200:15:auto` is debuggable in the
  DB and collision-free by construction.
- **Worker renders its own thumbnails.** The OrcaSlicer CLI (`--slice 0`) does
  not emit a plate thumbnail, so the worker rasterises the parsed mesh itself (a
  small software renderer — no GL, no native deps).
- **Integer paise everywhere.** No floating-point money.
- **Catalog passed as a parameter** to the pricing engine, so a future
  DB-backed catalog needs no engine changes.

See [PRICING.md](PRICING.md), [ORCA-PROFILES.md](ORCA-PROFILES.md) and
[DATABASE.md](DATABASE.md) for the details of each subsystem.
