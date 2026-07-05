#!/bin/sh
# Apply pending migrations, then boot the Next.js standalone server.
set -e

echo "[web] Applying database migrations…"
prisma migrate deploy --schema=/app/prisma/schema.prisma

echo "[web] Starting Next.js on :${PORT:-3000}…"
exec node apps/web/server.js
