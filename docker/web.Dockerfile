# Next.js web container. The Dockerfile also provides a separate short-lived
# migration target, while the public runner excludes psql and owner credentials.
# Builder and runner share the same debian base so the Prisma query engine
# generated at build time matches the runtime platform.

FROM node:26-slim@sha256:ffc78385a788964bb3cbab5e434ff79a10bdc25b8ae6db03fe5fe6cb14053c09 AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@11.12.0 --activate
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
# The DB package has no local-workspace runtime dependency. Keep the proven
# pnpm 9 deploy layout without globally injecting workspace packages into
# development installs.
RUN pnpm --filter @print/db generate \
    && pnpm --filter @print/web build \
    && pnpm --filter @print/db deploy --legacy /opt/migrate

# ---------- runtime base: no build/package-manager tooling ----------
FROM base AS runtime-base
# npm/Corepack/pnpm are build-time tools only. Removing them from the runtime
# image eliminates their archive/config parsers and associated advisory surface;
# web and migration modes invoke node/Prisma directly.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /root/.cache/node/corepack /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && groupadd -g 1001 nextjs \
    && useradd -m -u 1001 -g 1001 nextjs
COPY docker/web-entrypoint.sh /usr/local/bin/web-entrypoint.sh
RUN chmod +x /usr/local/bin/web-entrypoint.sh

# ---------- one-shot migration/provisioning image ----------
# Keep psql and its larger OS dependency tree out of the public web runtime.
FROM runtime-base AS migrate
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/packages/db/prisma /app/prisma
COPY --from=build /opt/migrate /opt/migrate
COPY apps/web/scripts/provision-database.mjs /app/provision-database.mjs
USER nextjs
ENTRYPOINT ["/usr/local/bin/web-entrypoint.sh"]

# ---------- public web runner: minimal standalone image ----------
FROM runtime-base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Next standalone bundle (monorepo layout: server.js lives at apps/web/server.js).
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
# The Prisma query engine binary — Next's file tracing bundles the client code
# but not this native addon. `.next/server` is one of the runtime's search
# paths, so drop it there.
COPY --from=build /app/packages/db/generated/client/libquery_engine-*.so.node ./apps/web/.next/server/
COPY apps/web/scripts/validate-env.mjs /app/validate-env.mjs

# Pre-create the data dirs owned by the runtime user. Docker initialises the
# empty named volumes from these paths, so the mounted volumes inherit nextjs
# ownership (otherwise they default to root and uploads fail with EACCES).
RUN mkdir -p /data/uploads/thumbs /data/uploads/tmp /data/pdfs \
    && chown -R nextjs:nextjs /data \
    && chmod 0700 /data/uploads /data/uploads/thumbs /data/uploads/tmp /data/pdfs

USER nextjs
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/web-entrypoint.sh"]
