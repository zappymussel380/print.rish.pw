# Maintenance

## Backups

Durable state includes PostgreSQL (quotation/customer PII and slice cache),
uploads/thumbnails, and PDFs. Database dumps and PDFs are sensitive even when
model files have expired.

Create backups through a same-directory temporary file, publishing the dump by
atomic rename only after `pg_dump` succeeds and produces non-empty output:

```bash
(
  set -eu
  umask 077
  backup="postgres-$(date -u +%FT%H%M%SZ).dump"
  tmp="$(mktemp "./.${backup}.tmp.XXXXXX")"
  trap 'rm -f -- "$tmp"' EXIT
  trap 'exit 1' HUP INT TERM

  if docker compose exec -T postgres sh -c \
      'exec pg_dump --format=custom -U "$POSTGRES_USER" "$POSTGRES_DB"' \
      > "$tmp" && test -s "$tmp"; then
    mv -- "$tmp" "$backup"
    trap - EXIT HUP INT TERM
  else
    echo "PostgreSQL backup failed; no final dump was published" >&2
    exit 1
  fi
)
```

Encrypt uploads/PDFs and the dump, copy them to immutable/off-host storage whose
credentials are unavailable to the application host, enforce retention, and
alert on backup age/failure. Same-host snapshots help recovery but are not
backups. Restore a sample regularly into an isolated database and verify rows,
PDFs, and model files; an untested backup is unverified.

A complete point-in-time set contains the PostgreSQL custom dump,
`uploads.tar.gz`, `pdfs.tar.gz`, and a checksum manifest. A database-only dump
is incomplete. Quiesce writes by stopping proxy, web, and worker while leaving
PostgreSQL running; create all three artifacts in that window, then restart the
services immediately. The transfer commands in
[STORAGE_VAULT_LXC.md](STORAGE_VAULT_LXC.md#6-move-data-from-the-current-lxc)
show the archive shape. Publish artifacts only after non-empty checks,
`pg_restore --list`, tar listing, and `sha256sum -c` all pass.

## Restore drills

Use a fresh isolated PostgreSQL instance and fresh upload/PDF storage, never the
live volumes. Verify the manifest before extraction, restore numeric ownership
to `1001:1001`, directories to `0700`, and files to `0600`. Run `pg_restore`
from the target PostgreSQL image/version rather than an arbitrary host client;
then run current migrations and the database-role provisioner. Redis starts
empty because it is coordination state, not the source of truth.

Before starting a restored worker (whose startup retention sweep may
legitimately delete old data), verify table/migration counts, zero broken
foreign keys, every model file's size and SHA-256 against `UploadedModel`, every
expected thumbnail, and every non-null quotation PDF (non-empty with a `%PDF-`
header). Check restored file counts, bytes, ownership, and modes. Destroy the
isolated target after recording non-sensitive evidence.

### Verification record — 2026-07-13

Task 2.3 was drilled against a new coherent set created at
`2026-07-13T13:11:15Z`. With operator-approved maintenance, proxy/web/worker
were quiesced for **13 seconds** (under the five-minute limit); PostgreSQL and
Redis remained running. Production returned healthy afterward through the
public `/api/health` path (`db=true`, `redis=true`). The root-owned set is mode
`0700`; each artifact is mode `0600`:

- `postgres.dump` — SHA-256
  `b1dd181d6800d6a587d5904051762d4a4357e6b113f5f34ffcbabb5937e77815`.
- `uploads.tar.gz` — SHA-256
  `2ad0447b70e0411b4f4589649b470f74d703a25e98c28a4bbfb378d3225b5325`.
- `pdfs.tar.gz` — SHA-256
  `9323a3bd93d9bbb4b34c00038515e6b1032e11204998b0bb5aa74c89c00dedff`.
- `SHA256SUMS` verified all three before the successful restore.

The accepted clean target was a same-host, loopback-only throwaway PostgreSQL
16.14 container with fresh PostgreSQL/upload/PDF named volumes. Its bundled
PG16 `pg_restore --exit-on-error --clean --if-exists --no-owner
--no-privileges` completed successfully. Current migrations reported all eight
applied, and least-privilege web/worker roles were reprovisioned.

Before and after migration/provisioning the restored database held 3 models,
75 slice results, 0 quotations, 0 quotation items, 0 status-history rows, and 1
quotation counter; foreign-key orphan count was zero. All 3 model files matched
their database sizes and SHA-256 hashes, all 3 expected thumbnails were
non-empty, and the restored upload volume contained exactly 6 files / 18,397,389
bytes with the documented ownership and modes. The PDF archive restored as an
empty volume, matching 0 database PDF pointers (0/0); a future drill after a
real PDF exists must provide the positive `%PDF-` recovery check.

Peak disposable-target use was about 67 MB while the host filesystem was 90%
used. The throwaway container and all three drill volumes were deleted; no
`task23-*` resources remained. The coherent backup set remains root-only on
this host, so it still must be encrypted and copied off-host to become a
disaster-resilient backup rather than a same-host recovery copy.

## Automatic retention and reconciliation

The worker runs cleanup once at startup and then daily:

1. Unattached uploads older than `UPLOAD_RETENTION_HOURS` (48 hours) are claimed
   by a conditional delete, then their derived model/thumbnail paths are
   removed.
2. Model files referenced only by immutable terminal quotations older than
   `FILE_RETENTION_DAYS` (30 days) are purged; DB rows and PDFs remain until the
   quotation-retention step below. The model endpoint then returns `410
   FILE_EXPIRED`.
3. Quotations in `COMPLETED`, `DELIVERED`, or `CANCELLED` whose `updatedAt` is
   older than the `QUOTATION_RETENTION_DAYS` threshold (90 days by default and
   at most) are deleted by the next daily sweep. The quotation row, including
   customer contact and address fields, is deleted first; schema cascades
   remove its items and status history. Cleanup then unlinks its PDF,
   conditionally deletes models that now have no quotation items, and unlinks
   any remaining model/thumbnail files. The earlier 30-day file sweep means
   those model files will normally already be gone.
4. Model/thumbnail/PDF directories are reconciled in bounded batches. Files
   with no matching authoritative row/pointer and temporary crash leftovers
   older than two hours are removed. Accepted ingest tickets own their temp
   files until completion/failure; the queue cap and capacity reservations
   bound that live set, while this grace period handles worker crashes.

Database scans and filesystem reconciliation are paginated so historical row
growth does not require materializing the entire dataset. Cleanup errors are
logged and retried; paths are derived from IDs rather than trusted DB text.

Non-terminal quotations are never automatically deleted. The operator must move
each order to a terminal state before its stable retention window begins.
Deletion also removes revenue history from the app. If records older than the
configured threshold (90 days by default and at most) are needed, download the
admin CSV export periodically and retain it under an appropriate access and
deletion policy. The sweep does not preserve a long-term reporting copy.

## Upgrading OrcaSlicer or profiles

1. Download the exact official AppImage separately and calculate SHA-256.
2. Update `ORCA_VERSION` and `ORCA_SHA256` in `docker/worker.Dockerfile`.
3. Re-flatten committed profiles and run the calibration-cube smoke gate in
   [ORCA-PROFILES.md](ORCA-PROFILES.md).
4. Scan the extracted runtime and confirm any GUI-only vulnerable assets pruned
   by the Dockerfile remain unnecessary to headless slicing.
5. Bump `SLICE_PIPELINE_VERSION` in
   `packages/shared/src/settings-key.ts`. This is mandatory for any slicer,
   machine, process, or filament change that can affect toolpaths.
6. Rebuild and deploy the worker.

Old cache rows remain in PostgreSQL but the versioned key makes them harmless
misses. Never leave them active after a toolpath-affecting upgrade.
The CI HTTP funnel uses a production-refused synthetic slicer to verify the app
integration only; it does not validate Orca, profiles, or toolpaths and cannot
replace step 3.

## Updating the app

```bash
git pull --ff-only
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs migrate
```

The short-lived migration service applies reviewed SQL and re-provisions web
and worker grants before either starts. Treat destructive/irreversible
migrations as a release decision; checking out old code does not reverse data
changes.

Pinned image digests, pnpm dependencies, Actions, CodeQL, and Trivy are tracked
by CI/Dependabot. Builds use pinned pnpm 11 and reject dependency releases less
than 24 hours old; review any exception instead of disabling that policy.
Release checks should also scan the final web, migration, and worker images,
including advisories without a current fix, because base-image tools are not
visible in a lockfile-only scan. The fix-available CI gate is actionable but
does not imply that the all-advisory report is empty. Review updates and rerun
tests/build/smoke slicing before deployment.

## Monitoring

- `/api/health` reports DB/Redis status and is briefly coalesced. Its regular
  probe also observes `worker:heartbeat`; a continuously missing heartbeat or
  unreachable Redis for more than one minute sends a static, PII-free Telegram
  operator alert when Telegram is configured. Repeats are capped to one per 15
  minutes and report the number suppressed; recovery resets the outage timer.
- Worker health checks publish `worker:heartbeat` in authenticated Redis. The
  web service observes it so the backend-only worker and untrusted Orca child
  receive neither Telegram credentials nor an internet route.
- When Telegram is configured, unexpected checkout exceptions, checkout
  capacity 503s, quotation-PDF failures, the Shiprocket daily cap, and
  ingest queue saturation also send static alerts without customer data.
  Each alert kind is limited to one send per 15 minutes across web replicas;
  the next send reports how many similar alerts were suppressed. A
  process-local fallback keeps the cap during Redis outages.
- Alert on disk/free-inode usage, PDF/upload growth, Postgres growth, Redis
  memory, checkout circuit-breaker events, worker restarts/timeouts, migration
  failures, and backup age.
- Logs are structured and omit query strings and known customer fields,
  but still restrict access and retention; exceptions/upstream software can
  introduce sensitive data.

```bash
docker compose logs -f web worker migrate
```

## Rotating access credentials

Admin password:

```bash
pnpm --filter @print/web hash-password
```

Put the doubled-dollar hash in production `.env` and recreate web. Changing the
hash does **not** revoke already-issued 12-hour admin JWTs. For emergency global
revocation also rotate `SESSION_SECRET`; this invalidates admin sessions,
anonymous quote sessions, and shipping estimate tokens. It does not revoke
30-day quotation capabilities; delete the quotation to revoke one immediately.

To rotate web/worker database passwords, update their runtime URLs and rerun the
migration service with the still-valid owner URL; it rotates both roles before
the services restart. Rotate the owner interactively first with `psql`'s
`\password <owner-role>`, then update `POSTGRES_PASSWORD` and
`MIGRATION_DATABASE_URL`. Rotate Redis by coordinating the server password and
both clients; expect queued/rate-limit state disruption if replacing its data.

## Common issues

| Symptom | Cause / fix |
| --- | --- |
| Upload returns 413 below 300 MiB | An edge proxy does not have an exact `/api/uploads` 301 MiB exception. |
| Upload returns 408 | The absolute 10-minute body deadline elapsed. |
| Upload is queued at 0 but not processing | Check `worker:heartbeat`, worker logs, and authenticated Redis; the UI reports when the processor is offline. |
| Upload returns `INGEST_QUEUE_FULL` | The bounded FIFO already has 25 outstanding uploads. Check worker health/latency and disk before raising capacity elsewhere; the bound is intentional. |
| Admin login always fails after Compose edit | Bcrypt `$` was not doubled to `$$` in root `.env`. |
| Web/worker wait indefinitely | Inspect the one-shot `migrate` exit/log and role URLs. |
| Slice stays queued | Check worker health, authenticated Redis, and pipeline/Orca version match. |
| Redis `NOAUTH` | Server/client password or percent-encoding differs. |
| Prisma engine missing | Regenerate the client and rebuild the pinned Node 24 image. |
