# Environment variables

Copy `.env.example` to `.env`, fill in values, and run `chmod 0600 .env`.
Production secrets have no usable defaults and are validated before startup.
Passwords embedded in URLs must be percent-encoded.

## Core and database roles

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `APP_ORIGIN` | production | local HTTP origin | Exact public origin used for CSRF, cookies, CSP/HSTS, and generated links. Production requires HTTPS and no path/query. |
| `PROXY_BIND` | deployment | `127.0.0.1` | Host address for compose port 8080. Use only the private address reached by the public proxy; never `0.0.0.0`. |
| `TRUSTED_PROXY_CIDR` | compose | none | Required exact transport source allowed to assert client IP/scheme. Accepts one IPv4 host (no prefix or `/32`) or unbracketed IPv6 host (no prefix or `/128`); startup rejects subnets, lists, hostnames, and invalid/config syntax. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | compose | none | Schema owner created by the Postgres image. Use a long random owner password. |
| `MIGRATION_DATABASE_URL` | production | none | Schema-owner URL used only by the short-lived `migrate` service. |
| `DATABASE_URL` | yes | none | Distinct `print_web`-style runtime URL. The migration task provisions broad business-table DML, column-scoped `SliceResult` writes that exclude slicer measurements/raw metadata, and no DDL rights. |
| `WORKER_DATABASE_URL` | compose | none | Distinct worker runtime URL. It receives only model/slice/retention table grants. |
| `REDIS_PASSWORD` | compose | none | Long random Redis server password. |
| `REDIS_URL` | local/non-compose | local Redis | Authenticated Redis URL. Compose constructs service-specific URLs from `REDIS_PASSWORD`. |

Migration, web, and worker database usernames and passwords must all be
different and each password must be at least 32 bytes. On every deployment the
migration task reapplies least-privilege grants before long-running services
start.

Despite its historical name, `TRUSTED_PROXY_CIDR` is deliberately a single-host
allowlist, not a network. It must match the outer proxy's transport address as
shown by the compose proxy's `peer=` access-log field. Firewall port 8080 to the
same source; compose nginx also returns 403 to every other transport peer. The
compose proxy overwrites `X-Real-IP` and `X-Forwarded-For` and passes the original
transport peer internally as `X-Proxy-Peer-IP`.

## Session/admin secrets

| Variable | Required | Notes |
| --- | --- | --- |
| `SESSION_SECRET` | yes | At least 32 random bytes; signs purpose-separated quote, admin, and shipping tokens. Generate with `openssl rand -hex 32`. |
| `ADMIN_PASSWORD_HASH` | yes | Generate with the prompt-only `pnpm --filter @print/web hash-password`. Input must have at least 12 characters and at most 72 UTF-8 bytes. |

Docker Compose interpolates `$` in `.env`; double every `$` in the bcrypt hash
to `$$`. The container receives the intended single-dollar value.

## Business and third-party services

| Variable | Default | Notes |
| --- | --- | --- |
| `WHATSAPP_NUMBER` | empty | International digits only. Empty disables the pre-filled handoff. Customer/order details are sent to WhatsApp when used. |
| `CONTACT_EMAIL` | empty | Public address shown on the contact page. |
| `GOOGLE_MAPS_EMBED_URL` | empty | Optional exact Google Maps HTTPS embed URL; enables Google in CSP `frame-src`. |
| `RESEND_API_KEY` / `MAIL_TO` | none | Both are required for contact-form delivery. Messages contain the submitted name, email, subject, and message; the contact form has no phone field. |
| `CONTACT_FROM` | `print.rish.pw <contact@rish.pw>` | Verified Resend sender. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | empty | Both enable order notifications containing customer/order details. |
| `TELEGRAM_MESSAGE_THREAD_ID` | empty | Optional positive Telegram forum topic ID. |
| `SHIPROCKET_EMAIL` / `SHIPROCKET_PASSWORD` | none | Optional API-user credentials for shipping estimates; do not use the dashboard login. |
| `SHIPROCKET_PICKUP_PINCODE` | `781001` | Workshop origin pincode. |

Treat third-party configuration as a privacy decision, not only a technical
one. Review vendor retention/access terms before enabling it.

## Files, quotas, and retention

| Variable | Default | Notes |
| --- | --- | --- |
| `UPLOAD_DIR` | `./data/uploads` | Model/thumbnail vault (`/data/uploads` in Compose). |
| `PDF_DIR` | `./data/pdfs` | Quotation PDF vault (`/data/pdfs` in Compose). |
| `MAX_UPLOAD_MB` | `300` | Per-file limit; values above the hard 300 MiB cap are reduced to 300. |
| `MAX_SESSION_UPLOAD_MB` | `900` | Persistent active-upload bytes per anonymous quote session. |
| `UPLOAD_WINDOW_MB` | `900` | Accepted upload bytes per observed IP per 10 minutes. |
| `DOWNLOAD_WINDOW_MB` | `1200` | Model download bytes per observed IP per 10 minutes. |
| `STORAGE_RESERVE_MB` | `2048` | Free-space reserve preserved by capacity reservations and final checks. |
| `MAX_MODELS_PER_SESSION` | `20` | Active models in one quote session. |
| `UPLOAD_RETENTION_HOURS` | `48` | Unattached upload lifetime. |
| `FILE_RETENTION_DAYS` | `30` | Model-file lifetime after all referencing quotations are terminal and old. Quotation/model rows and PDFs remain until the quotation sweep. |
| `QUOTATION_RETENTION_DAYS` | `90` | Deletion threshold measured from `updatedAt` for `COMPLETED`, `DELIVERED`, and `CANCELLED` quotations. Policy caps the threshold at 90 days, so larger values are reduced to 90; the next daily sweep deletes the quotation and its customer/contact/address data, items/history, PDF, and models that become unreferenced. Non-terminal quotations do not age out. |
| `PRINT_DB_DIR`, `PRINT_UPLOAD_DIR`, `PRINT_PDF_DIR`, `PRINT_REDIS_DIR` | none | Required host paths when using `docker-compose.vault.yml`. |

## Worker

| Variable | Default | Notes |
| --- | --- | --- |
| `WORKER_CONCURRENCY` | `2` | Parallel slicers; hard maximum 8. |
| `SLICE_TIMEOUT_SECONDS` | `180` | Per-slice timeout; hard maximum 900 seconds. |
| `THUMB_SIZE` | `512` | Square PNG size; hard maximum 1024 px. |
| `ORCA_BIN` | `/opt/orca/AppRun` | Baked-in executable. |
| `ORCA_VERSION` | `2.4.1` | Must agree with the pinned image/cache pipeline version. |
| `PROFILES_DIR` | worker profiles | Flattened, committed A1 profiles. |
| `SLICE_WORK_DIR` | `/tmp/slice-jobs` | Private per-job scratch root. |
| `SLICER_UID` / `SLICER_GID` | `1002` / `3000` | Base identity for untrusted per-job slicer processes. |
| `STORAGE_UID` / `STORAGE_GID` | `1001` / `1001` | Durable storage owner. |
| `LOG_LEVEL` | `info` | Structured web/worker log level. |
| `ALLOW_INSECURE_SLICER` | false | Dangerous local-development escape hatch. Ignored in production; never deploy it. |

## Process exposure

- `migrate`: only the owner URL plus the two runtime URLs; exits after migrations
  and grants.
- `web`: explicit allowlist of its runtime DB URL, Redis URL, session/admin and
  configured provider secrets, and web quota settings. It never receives the
  migration/worker database URLs or the PostgreSQL owner password.
- `worker`: worker DB URL, authenticated Redis URL, storage paths, and worker
  knobs only. It receives no session/admin/provider secrets. Each Orca process
  gets a private model copy and a minimal explicit, credential-free environment
  containing only process basics such as `PATH`, locale, `HOME`, and
  `XDG_RUNTIME_DIR`. Compose CPU, memory, and PID limits apply to the whole
  worker container and all concurrent slicers, not individually to each Orca
  process; the slicer timeout is per job.
