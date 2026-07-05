# print.rish.pw — Instant 3D-Printing Quotation System

A production 3D-printing quotation app. Customers upload STL / 3MF / OBJ / AMF
models, every model is **actually sliced** with OrcaSlicer (Bambu Lab A1, 0.4 mm
nozzle — no mathematical estimation), and they get a live, itemised quote they
can tweak and submit. Submitting generates a PDF and hands off to WhatsApp.
Includes marketing pages and a password-protected admin dashboard.

> Part of the [rish.pw](https://rish.pw) repository. **Only the code is MIT
> licensed** — site content, photos and generated PDFs are not licensed for reuse.

## What's inside

| Area | Tech |
| --- | --- |
| Web (UI + API) | Next.js 15 App Router, TypeScript, Tailwind v4 |
| 3D preview | three.js (dynamic, client-only) |
| Slicing worker | OrcaSlicer headless + BullMQ |
| Data | PostgreSQL + Prisma |
| Queue / cache / rate limits | Redis |
| PDF | @react-pdf/renderer |
| Deploy | Docker Compose (proxy · web · worker · postgres · redis) |

## Repository layout

```
print/
├── apps/web/        Next.js app (routes, components, lib)
├── apps/worker/     BullMQ worker: OrcaSlicer runner, thumbnails, retention
├── packages/
│   ├── db/          Prisma schema + client singleton
│   ├── shared/      catalog, pricing engine, zod schemas, helpers
│   └── geometry/    STL/3MF/OBJ/AMF parser (bbox, volume, triangle soup)
├── docker/          Dockerfiles + nginx proxy config
└── docs/            architecture, install, deploy, env, db, api, pricing, …
```

## Quick start (development)

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d        # Postgres + Redis
cp .env.example .env                                   # then fill in secrets
pnpm --filter @print/db migrate:dev
pnpm dev                                               # web + worker
```

See [docs/INSTALL.md](docs/INSTALL.md) for the full walkthrough and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for production.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — how the pieces fit together
- [Install](docs/INSTALL.md) — local development
- [Deployment](docs/DEPLOYMENT.md) — production, proxy topology, the VPS edge
- [Environment](docs/ENV.md) — every variable
- [Database](docs/DATABASE.md) — schema and migrations
- [API](docs/API.md) — endpoint reference
- [Pricing](docs/PRICING.md) — how quotes are computed and how to change rates
- [Orca profiles](docs/ORCA-PROFILES.md) — the slicing profiles and re-flattening
- [Maintenance](docs/MAINTENANCE.md) — backups, retention, upgrades
