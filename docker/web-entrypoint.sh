#!/bin/sh
# Run either the short-lived privileged migration task or the unprivileged web
# process. The two modes receive different credentials from Compose.
set -eu

mode="${1:-web}"

if [ "$mode" = "migrate" ]; then
  export DATABASE_URL="${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL is required}"
  echo "[migrate] Applying database migrations…"
  /opt/migrate/node_modules/.bin/prisma migrate deploy --schema=/app/prisma/schema.prisma
  echo "[migrate] Provisioning least-privilege runtime roles…"
  node /app/provision-database.mjs
  echo "[migrate] Database ready"
  exit 0
fi

if [ "$mode" != "web" ]; then
  echo "Unknown entrypoint mode: $mode" >&2
  exit 64
fi

node /app/validate-env.mjs

# Existing named/bind volumes may predate private per-job staging. The web owns
# durable files; the untrusted slicer never receives direct vault access.
mkdir -p /data/uploads/thumbs /data/uploads/tmp /data/pdfs
chgrp 1001 /data/uploads /data/uploads/thumbs /data/uploads/tmp /data/pdfs
chmod 0700 /data/uploads /data/uploads/thumbs /data/uploads/tmp /data/pdfs
find /data/uploads -maxdepth 1 -type f -exec chgrp 1001 {} + -exec chmod 0600 {} +
find /data/uploads/thumbs -maxdepth 1 -type f -exec chgrp 1001 {} + -exec chmod 0600 {} +

echo "[web] Starting Next.js on :${PORT:-3000}…"
exec node apps/web/server.js
