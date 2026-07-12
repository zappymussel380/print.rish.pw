# Install (development)

## Prerequisites

- Node.js 24 or newer and pnpm 9 (`corepack enable`)
- Docker and Docker Compose v2 for Postgres/Redis
- The hardened worker container for real slicing; UI/API work can run web-only

## 1. Install dependencies

```bash
pnpm install --frozen-lockfile
```

## 2. Start development services

```bash
docker compose -f docker-compose.dev.yml up -d
```

This exposes Postgres only on `127.0.0.1:5433` and Redis only on
`127.0.0.1:6380`.

## 3. Configure the web app

Next loads environment files from `apps/web`, so create
`apps/web/.env.local` for local web development:

```dotenv
APP_ORIGIN=http://localhost:3000
DATABASE_URL=postgresql://print:print@localhost:5433/print
REDIS_URL=redis://localhost:6380
SESSION_SECRET=<output-of-openssl-rand-hex-32>
ADMIN_PASSWORD_HASH=<single-dollar-bcrypt-hash>
```

Generate values without putting the plaintext admin password in argv:

```bash
openssl rand -hex 32
pnpm --filter @print/web hash-password
```

The password helper requires at least 12 characters and at most 72 UTF-8 bytes.
Do not double `$` in
`apps/web/.env.local`; doubling is only needed for the production Compose
`.env` interpolation path. `APP_ORIGIN` must be local HTTP or CSRF and cookie
behavior will not match the development URL.

Optional business/provider variables are listed in [ENV.md](ENV.md).

## 4. Apply migrations

```bash
DATABASE_URL=postgresql://print:print@localhost:5433/print \
  pnpm --filter @print/db migrate:dev
```

Development uses one database owner for convenience. Production uses the
separate migration/web/worker roles described in [DEPLOYMENT.md](DEPLOYMENT.md).

## 5. Run web-only development

```bash
pnpm --filter @print/web dev
```

- App: <http://localhost:3000>
- Admin: <http://localhost:3000/admin>

Uploads and UI/API work without Orca, but slice jobs stay queued. Do not run the
worker casually under your login: it fails closed when it cannot isolate Orca
from credentials. `ALLOW_INSECURE_SLICER=true` is an explicit local-only escape
hatch and gives hostile native code access to worker credentials/uploads.

For end-to-end slicing, configure the production-style root `.env` and run the
hardened Compose stack:

```bash
docker compose up -d --build
```

Then use the private compose proxy on port 8080. See
[DEPLOYMENT.md](DEPLOYMENT.md).

## Useful commands

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm audit
pnpm --filter @print/db studio
pnpm --filter @print/web hash-password
```

See [ORCA-PROFILES.md](ORCA-PROFILES.md) for the pinned slicer/profile workflow.
