# Maintenance

## Backups

What holds durable state:

- **Postgres** (`pgdata` volume) — quotations, models, slice cache. The source of
  truth; back this up.
- **`pdfs` volume** — generated quotation PDFs (regenerable in principle, but
  cheap to keep).
- **`uploads` volume** — model files + thumbnails (subject to retention).

Example nightly Postgres dump:

```bash
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > backup-$(date +%F).sql.gz
```

Restore into a fresh DB with `gunzip -c … | psql`.

## Data retention (automatic)

The worker runs a daily BullMQ repeatable job (`apps/worker/src/retention.ts`):

1. **Unattached uploads** older than `UPLOAD_RETENTION_HOURS` (default 48) —
   files, thumbnails and DB rows deleted.
2. **Terminal quotations** (COMPLETED/DELIVERED/CANCELLED) older than
   `FILE_RETENTION_DAYS` (default 30) — model files removed on disk; DB rows and
   PDFs kept. The file endpoint returns `410 FILE_EXPIRED` afterwards.

Tune via the env vars in [ENV.md](ENV.md).

## Upgrading OrcaSlicer

1. Bump `ORCA_VERSION` in `docker/worker.Dockerfile`.
2. Re-flatten profiles against the new AppImage (see
   [ORCA-PROFILES.md](ORCA-PROFILES.md)) and run the calibration-cube smoke gate.
3. Rebuild: `docker compose build worker && docker compose up -d worker`.
4. Slice caches from the old version stay valid; force a re-slice by changing a
   setting if you want fresh numbers.

## Updating the app

```bash
git pull
docker compose up -d --build      # migrate deploy runs automatically on web start
```

Migrations are applied by the web entrypoint. Roll back by checking out the
previous tag and rebuilding (irreversible migrations excepted — review before
deploying).

## Health & monitoring

- `GET /api/health` → `{ ok, db, redis }`; the web container healthcheck uses it.
- The worker refreshes a Redis `worker:heartbeat` key (TTL 30 s); its healthcheck
  asserts the key exists.
- Logs: `docker compose logs -f web worker`. Both use structured pino with
  customer PII (email/phone/notes/name) redacted.

## Rotating the admin password

```bash
pnpm --filter @print/web hash-password '<new-password>'
```

Put the hash in `.env` (remember `$`→`$$` for compose), then
`docker compose up -d web`.

## Common issues

| Symptom | Cause / fix |
| --- | --- |
| Uploads fail at ~100 MB with a 413 | VPS nginx `client_max_body_size` < 110m — see [DEPLOYMENT.md](DEPLOYMENT.md). |
| Admin login always wrong | `$` not doubled to `$$` in the compose `.env` hash. |
| Slices stuck "queued" | Worker not running/healthy — `docker compose ps`, check worker logs. |
| Prisma "engine not found" after a change | Re-run `pnpm --filter @print/db generate` and rebuild. |
