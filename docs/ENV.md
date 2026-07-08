# Environment variables

Copy `.env.example` to `.env` and fill in values. `.env` is git-ignored.
Secrets have **no defaults** and fail loudly at first use.

## Core

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `APP_ORIGIN` | yes (prod) | `http://localhost:3000` | Public origin; used for CSRF origin checks and links. |
| `PROXY_BIND` | yes (prod) | `127.0.0.1` | Host address the compose proxy binds `8080` to. Set to the private address reached by the public reverse proxy; never `0.0.0.0`. |
| `TRUSTED_PROXY_CIDR` | yes (prod) | `127.0.0.1` | Source allowed to assert the real client IP via `X-Real-IP` (VPS, subnet router, or NPM LXC address). Rate limiting depends on it. |
| `DATABASE_URL` | yes | — | PostgreSQL connection string. |
| `REDIS_URL` | — | `redis://localhost:6379` | Redis connection string. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | yes (compose) | — | Wired into the Postgres container and `DATABASE_URL`. |

## Secrets

| Variable | Required | Notes |
| --- | --- | --- |
| `SESSION_SECRET` | yes | ≥32-byte random; signs the quote-session and admin cookies (`openssl rand -hex 32`). |
| `ADMIN_PASSWORD_HASH` | yes | bcrypt hash from `pnpm --filter @print/web hash-password '<pw>'`. **Double every `$`→`$$`** when using docker-compose `.env`. |

## Business

| Variable | Default | Notes |
| --- | --- | --- |
| `WHATSAPP_NUMBER` | — | International format, digits only (e.g. `919876543210`). Empty disables the pre-filled handoff. |
| `CONTACT_EMAIL` | `hello@rish.pw` | Shown on the contact page. |
| `BUSINESS_HOURS` | `Mon–Sat, 10:00–19:00 IST` | Contact page. |
| `GOOGLE_MAPS_EMBED_URL` | — | Optional Maps embed; also whitelists `frame-src` in the CSP when set. |

## Files & retention

| Variable | Default | Notes |
| --- | --- | --- |
| `UPLOAD_DIR` | `./data/uploads` (`/data/uploads` in compose) | Model + thumbnail storage. |
| `PDF_DIR` | `./data/pdfs` (`/data/pdfs` in compose) | Generated quotation PDFs. |
| `MAX_UPLOAD_MB` | `100` | Per-file upload cap. |
| `MAX_MODELS_PER_SESSION` | `20` | Models per quote. |
| `UPLOAD_RETENTION_HOURS` | `48` | Purge uploads never attached to a quotation after this. |
| `FILE_RETENTION_DAYS` | `30` | Remove model files of terminal-state quotations after this (rows/PDFs kept). |

## Worker

| Variable | Default | Notes |
| --- | --- | --- |
| `WORKER_CONCURRENCY` | `2` | Parallel OrcaSlicer processes. |
| `SLICE_TIMEOUT_SECONDS` | `180` | Hard kill for a single slice. |
| `THUMB_SIZE` | `512` | Thumbnail PNG resolution (square). |
| `ORCA_BIN` | `/opt/orca/AppRun` | Baked into the worker image. |
| `PROFILES_DIR` | `<worker>/profiles` | Flattened Bambu A1 profiles. |
| `SLICE_WORK_DIR` | `/tmp/slice-jobs` | Per-job scratch. |
| `LOG_LEVEL` | `info` | pino level (web + worker). |

## Which processes read what

- **web**: everything except the worker-only knobs.
- **worker**: `DATABASE_URL`, `REDIS_URL`, `UPLOAD_DIR`, and the worker section.
  The compose file passes the worker **only** these (no `env_file`): it spawns
  OrcaSlicer on untrusted uploads, so secrets like `SESSION_SECRET` or API keys
  must never be present in its environment.
