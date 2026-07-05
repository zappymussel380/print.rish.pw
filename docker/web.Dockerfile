# Next.js web container: standalone build + Prisma migrate-on-start.
# Builder and runner share the same debian base so the Prisma query engine
# generated at build time matches the runtime platform.

FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# ---------- deps: install with the lockfile, manifests only for caching ----------
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/geometry/package.json packages/geometry/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@print/web..."

# ---------- build: prisma client + next standalone ----------
FROM deps AS build
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm --filter @print/db generate \
    && pnpm --filter @print/web build

# ---------- runner: minimal standalone image ----------
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl wget ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm i -g prisma@6.2.1 \
    && useradd -m -u 1001 nextjs

# Next standalone bundle (monorepo layout: server.js lives at apps/web/server.js).
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
# Schema + migrations for `prisma migrate deploy` at start-up.
COPY --from=build /app/packages/db/prisma ./prisma
# The Prisma query engine binary — Next's file tracing bundles the client code
# but not this native addon. `.next/server` is one of the runtime's search
# paths, so drop it there.
COPY --from=build /app/packages/db/generated/client/libquery_engine-*.so.node ./apps/web/.next/server/
COPY docker/web-entrypoint.sh /usr/local/bin/web-entrypoint.sh
RUN chmod +x /usr/local/bin/web-entrypoint.sh

# Pre-create the data dirs owned by the runtime user. Docker initialises the
# empty named volumes from these paths, so the mounted volumes inherit nextjs
# ownership (otherwise they default to root and uploads fail with EACCES).
RUN mkdir -p /data/uploads/thumbs /data/uploads/tmp /data/pdfs && chown -R nextjs /data

USER nextjs
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/web-entrypoint.sh"]
