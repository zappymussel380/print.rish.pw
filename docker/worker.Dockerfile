# Slicing worker: Node 24 runtime + OrcaSlicer (headless via xvfb).
#
# Base is ubuntu:24.04 to match the glibc/webkit the upstream AppImage is built
# against (asset: OrcaSlicer_Linux_AppImage_Ubuntu2404_*). The AppImage is
# extracted at build time because FUSE is unavailable inside containers.

FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS node-runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ---------- stage 1: fetch + extract OrcaSlicer ----------
FROM ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90 AS orca

ARG ORCA_VERSION=2.4.1
ARG ORCA_SHA256=7aff29a0ac6bb906f11c069eefe83459781c3364bac20ba9529eb9937a231402
ADD https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v${ORCA_VERSION}/OrcaSlicer_Linux_AppImage_Ubuntu2404_V${ORCA_VERSION}.AppImage /tmp/orca.AppImage
# The headless worker never opens Orca's bundled GUI guide/include pages. Their
# Swiper 7 copy is affected by GHSA-hmx5-qpq5-p643; remove the unused JavaScript
# instead of carrying an exploitable package into the runtime.
RUN echo "${ORCA_SHA256}  /tmp/orca.AppImage" | sha256sum -c - \
    && chmod +x /tmp/orca.AppImage \
    && cd /tmp \
    && /tmp/orca.AppImage --appimage-extract >/dev/null \
    && rm -rf /tmp/squashfs-root/resources/web/guide/swiper \
        /tmp/squashfs-root/resources/web/include/swiper \
    && mv /tmp/squashfs-root /opt/orca \
    && rm /tmp/orca.AppImage

# ---------- stage 2: production worker dependency tree ----------
FROM node-runtime AS app-build
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate
WORKDIR /build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/geometry/package.json packages/geometry/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter "@print/worker..."
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN pnpm --filter @print/db generate \
    && pnpm --filter @print/worker build \
    && pnpm --filter @print/worker deploy --legacy --prod /opt/worker-app \
    && find /opt/worker-app -type f \( -name '*.test.ts' -o -name '*.test.js' \) -delete \
    && rm -rf /opt/worker-app/test-fixtures /opt/worker-app/src /opt/worker-app/build.mjs

# ---------- stage 3: runtime ----------
FROM ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90

ARG ORCA_VERSION=2.4.1
ENV ORCA_VERSION=${ORCA_VERSION} \
    ORCA_BIN=/opt/orca/AppRun \
    NODE_ENV=production \
    DEBIAN_FRONTEND=noninteractive

# OrcaSlicer runtime dependencies (GUI toolkit links even in CLI mode) + xvfb
# for the virtual display, + Node 24 for the BullMQ worker.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        xvfb \
        libgl1 \
        libegl1 \
        libglu1-mesa \
        libgtk-3-0 \
        libwebkit2gtk-4.1-0 \
        libgstreamer1.0-0 \
        libgstreamer-plugins-base1.0-0 \
        locales \
        openssl \
        redis-tools \
        util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# Copy the official Node image runtime instead of executing a remote repository
# setup script during the build.
COPY --from=node-runtime /usr/local /usr/local
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=orca /opt/orca /opt/orca

# Orca writes config/caches on startup; give it a writable, throwaway home.
ENV HOME=/tmp/orca-home \
    ORCA_DATADIR=/tmp/orca-data
RUN groupadd -g 1001 worker \
    && useradd -m -u 1001 -g 1001 worker \
    && mkdir -p /tmp/orca-home /tmp/orca-data /tmp/xdg /tmp/slice-jobs /data/uploads /data/pdfs \
    && chown -R worker:worker /tmp/orca-home /tmp/orca-data /tmp/xdg /tmp/slice-jobs /data/uploads /data/pdfs \
    && chmod 0700 /data/uploads /data/pdfs

WORKDIR /app
COPY --from=app-build /opt/worker-app ./worker

# The trusted orchestrator starts as root with a small capability allowlist. It
# launches each concurrent Orca through setpriv with a unique uid/gid and no
# capabilities. Orca receives only a verified private scratch copy, preventing
# it from reading DB/Redis secrets, the upload vault, or another active job.
# The worker ships compiled JS (dist/); tsx and other build tooling are
# intentionally absent from the runtime image.
# Standalone `docker run` fails closed as the unprivileged worker. The reviewed
# Compose service explicitly overrides this to root plus a narrow capability
# allowlist so the trusted orchestrator can drop each Orca child to a private
# credential-free UID and reap escaped descendants.
USER worker
CMD ["node", "/app/worker/dist/index.js"]
