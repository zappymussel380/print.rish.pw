# Architecture

## Overview

Two long-running application containers and one short-lived migration task
share a pnpm workspace:

- **web** (`apps/web`) — Next.js 15. Serves the UI and all API route handlers.
- **worker** (`apps/worker`) — a BullMQ consumer that runs OrcaSlicer, renders
  thumbnails, and performs the daily retention sweep.
- **migrate** (one-shot target from the web Dockerfile) — applies Prisma
  migrations and provisions separate least-privilege web/worker database roles.
  Its psql client and schema-owner credential are absent from the public runner.

They share three workspace packages:

- **`@print/db`** — the Prisma schema and a `PrismaClient` singleton.
- **`@print/shared`** — the pricing engine, the product catalog, zod schemas,
  the settings key, the WhatsApp/order-summary builders, money/format helpers.
- **`@print/geometry`** — a dependency-light parser for STL/3MF/OBJ/AMF that
  returns a triangle soup, bounding box and volume (no three.js in Node).

Backing services: **PostgreSQL** (Prisma) and authenticated **Redis** (BullMQ
queue, slice cache coordination, rate limits, worker heartbeat).

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
`POST /api/uploads` streams the multipart body through busboy to an exclusively
created private temporary file, hashing (sha256) as it flows. It has a
10-minute absolute deadline in addition to proxy idle timeouts. Geometry is
then parsed under a non-renewing cross-replica ingest lease — a successful parse
is a far stronger validity check than magic bytes — and checked against the
printer bed. The lease normally reduces overlap but is not a fencing guarantee
if work outlives it. Original STL/OBJ/raw-AMF bytes are atomically renamed to a
server-derived UUID path. Every 3MF and zipped AMF is instead converted from the
app-selected triangle stream to bounded binary STL before persistence, so the
original attacker-controlled ZIP namespace never reaches the native slicer.
Downstream STL parsing remains a separate parser boundary. Supported model units
are normalized to millimetres. Rows are scoped to an anonymous signed `qsid`
session cookie.
The route enforces a 300 MiB hard file limit, byte and session quotas, a storage
reserve, archive/XML expansion limits, at most 20 3MF plates, and a global
four-million-triangle/one-million-vertex budget. XML element/depth and OBJ line
budgets prevent small-input structural explosions. Relevant 3MF entries share
one aggregate decompression budget; storage reservations and session quotas use
the final expanded STL byte count. Persistence normally uses a per-session
Redis lease to keep parallel uploads from racing aggregate model-count or byte
limits, but the non-renewing lease is advisory if finalization outlives it.
Cross-replica byte reservations and a final filesystem check preserve the
configured free-space reserve independently.

### Slice + live pricing
The quote page requests a slice per model+settings via `POST /api/slices`:

1. Cache key = `sha256(file)` (`fileHash`) + `settingsKey`, where the latter is
   `pipeline-version:format:material:layerHeightUm:infillPct:supports`.
   Version and format prevent stale-profile and cross-format/polyglot reuse;
   colour/quantity remain excluded.
2. A completed hit is returned immediately; a queued/running hit checks that a
   live BullMQ job still exists. An explicit re-request conditionally changes a
   failed result back to queued with a fresh attempt UUID/job ID. A miss creates
   a `SliceResult` row and enqueues a BullMQ job whose ID is deterministic for
   that attempt (natural dedup of identical in-flight requests). Worker writes
   conditionally match the live attempt, so stale jobs/failure events cannot
   overwrite a newer or terminal state. The client polls `GET /api/slices/:id`
   every 1.5 s.
3. The trusted worker reloads the database-owned path and validates settings,
   type, size, and SHA-256 while staging a no-follow private copy. It writes a
   per-job process profile, then launches OrcaSlicer under `setpriv` with a
   unique uid/gid, no capabilities, and a minimal explicit credential-free
   environment. Concurrent jobs cannot read each other's scratch directories
   or the upload vault. CPU, memory, and PID ceilings apply to the aggregate
   worker container, while the slicer timeout applies per job.
4. Orca's `--pipe` JSON reports real `total_percent` progress. The worker stores
   that percentage and stage in PostgreSQL, while the client polls every 1.5 s.
5. The worker parses `Metadata/slice_info.config` from the exported 3MF for
   bounded/plausible weight/time fields, renders a work-bounded thumbnail, and
   marks the result complete. Progress writes are monotonic, coalesced, and
   limited to one per second so slicer-controlled messages cannot build a DB
   backlog.

Pricing is a **pure, isomorphic** function (`@print/shared/pricing`). The client
reprices instantly from cached slice results; the server reprices
authoritatively at checkout — client totals are never trusted.

### Checkout
`POST /api/quotations` rebuilds every line from DB slice results and reprices.
In one transaction it atomically claims each model as single-use, allocates an
`RSP-<year>-<seq>` number, and persists quotation/items/history. It then renders
a size-bounded PDF under a short Redis lease around the final free-space check
and exclusive write. Per-IP limits and a global daily circuit breaker bound
permanent-row/PDF/notification amplification.

The raw 256-bit customer capability is returned once and transported to the
confirmation page in a URL fragment, which is not sent in HTTP. Client code
redeems it with a same-origin bounded POST, receives a per-quotation HttpOnly
cookie, and removes the fragment. Only a SHA-256 verifier and 30-day expiry are
stored. Confirmation/PDF responses are private/no-store/no-referrer.

## Design decisions

- **No mathematical estimation.** Every price is backed by real toolpaths. This
  is the whole point, and dictates the async worker + cache design.
- **Readable, versioned settings key.**
  `orca-2.4.1-a1-v1:stl:PLA:200:15:auto` is debuggable and collision-free by
  construction.
- **Worker renders its own thumbnails.** The OrcaSlicer CLI (`--slice 0`) does
  not emit a plate thumbnail, so the worker rasterises the parsed mesh itself (a
  small software renderer — no GL, no native deps).
- **Integer paise everywhere.** No floating-point money.
- **Catalog passed as a parameter** to the pricing engine, so a future
  DB-backed catalog needs no engine changes.
- **Native slicer is untrusted.** It receives a private verified model copy,
  cannot read the orchestrator environment through `/proc`, has no capabilities,
  and runs without internet egress. Its output is size/decompression bounded and
  read without following symlinks. This limits impact; it is not a VM boundary.

See [PRICING.md](PRICING.md), [ORCA-PROFILES.md](ORCA-PROFILES.md) and
[DATABASE.md](DATABASE.md) for the details of each subsystem.
