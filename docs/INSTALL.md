# Install (development)

## Prerequisites

- Node.js ≥ 20 and pnpm 9 (`corepack enable`)
- Docker (for Postgres + Redis, and optionally the full stack)
- For local slicing you also need the worker's OrcaSlicer image; most UI work
  does not require it (the app runs fine, slices just stay "queued").

## 1. Install dependencies

```bash
pnpm install
```

## 2. Start Postgres + Redis

```bash
docker compose -f docker-compose.dev.yml up -d
```

This exposes Postgres on `localhost:5433` and Redis on `localhost:6380`.

## 3. Configure environment

```bash
cp .env.example .env
```

Fill in at least:

- `SESSION_SECRET` — `openssl rand -hex 32`
- `ADMIN_PASSWORD_HASH` — `pnpm --filter @print/web hash-password 'your-password'`
- point `DATABASE_URL` / `REDIS_URL` at the dev containers:

```
DATABASE_URL=postgresql://print:print@localhost:5433/print
REDIS_URL=redis://localhost:6380
```

See [ENV.md](ENV.md) for every variable.

## 4. Apply migrations

```bash
pnpm --filter @print/db migrate:dev
```

## 5. Run

```bash
pnpm dev            # web on :3000 + worker (parallel)
```

- App: <http://localhost:3000>
- Admin: <http://localhost:3000/admin> (redirects to `/admin/login`)

## Useful commands

```bash
pnpm build              # build every package
pnpm test               # run all unit tests
pnpm typecheck          # type-check every package
pnpm --filter @print/db studio        # Prisma Studio
pnpm --filter @print/web hash-password '<pw>'   # bcrypt an admin password
```

## Running the worker locally

The worker needs OrcaSlicer. The simplest path is to run just the worker in its
container against your host Postgres/Redis, or build the image and run it:

```bash
docker compose build worker
docker compose run --rm worker
```

Without the worker, uploads and the UI work; slices remain pending. See
[ORCA-PROFILES.md](ORCA-PROFILES.md) for how the slicing profiles are built.
