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
   older than two hours are removed.

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
  upload/ingest lock timeouts also send static alerts without customer data.
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
| Admin login always fails after Compose edit | Bcrypt `$` was not doubled to `$$` in root `.env`. |
| Web/worker wait indefinitely | Inspect the one-shot `migrate` exit/log and role URLs. |
| Slice stays queued | Check worker health, authenticated Redis, and pipeline/Orca version match. |
| Redis `NOAUTH` | Server/client password or percent-encoding differs. |
| Prisma engine missing | Regenerate the client and rebuild the pinned Node 24 image. |
