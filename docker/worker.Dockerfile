# Slicing worker: Node 20 runtime + OrcaSlicer (headless via xvfb).
#
# Base is ubuntu:24.04 to match the glibc/webkit the upstream AppImage is built
# against (asset: OrcaSlicer_Linux_AppImage_Ubuntu2404_*). The AppImage is
# extracted at build time because FUSE is unavailable inside containers.

# ---------- stage 1: fetch + extract OrcaSlicer ----------
FROM ubuntu:24.04 AS orca

ARG ORCA_VERSION=2.4.1
ADD https://github.com/SoftFever/OrcaSlicer/releases/download/v${ORCA_VERSION}/OrcaSlicer_Linux_AppImage_Ubuntu2404_V${ORCA_VERSION}.AppImage /tmp/orca.AppImage
RUN chmod +x /tmp/orca.AppImage \
    && cd /tmp \
    && /tmp/orca.AppImage --appimage-extract >/dev/null \
    && mv /tmp/squashfs-root /opt/orca \
    && rm /tmp/orca.AppImage

# ---------- stage 2: runtime ----------
FROM ubuntu:24.04

ARG ORCA_VERSION=2.4.1
ENV ORCA_VERSION=${ORCA_VERSION} \
    ORCA_BIN=/opt/orca/AppRun \
    DEBIAN_FRONTEND=noninteractive

# OrcaSlicer runtime dependencies (GUI toolkit links even in CLI mode) + xvfb
# for the virtual display, + Node 20 for the BullMQ worker.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        xvfb \
        libgl1 \
        libegl1 \
        libglu1-mesa \
        libgtk-3-0 \
        libwebkit2gtk-4.1-0 \
        libgstreamer1.0-0 \
        libgstreamer-plugins-base1.0-0 \
        locales \
    && rm -rf /var/lib/apt/lists/* \
    && sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# Node 20 (NodeSource) + redis-tools (worker healthcheck) + openssl (Prisma)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs redis-tools openssl \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY --from=orca /opt/orca /opt/orca

# Orca writes config/caches on startup; give it a writable, throwaway home.
ENV HOME=/tmp/orca-home \
    ORCA_DATADIR=/tmp/orca-data
RUN mkdir -p /tmp/orca-home /tmp/orca-data /data/uploads

WORKDIR /app

# ---------- worker application ----------
# Install workspace deps (worker + its workspace dependencies only).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/geometry/package.json packages/geometry/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter "@print/worker..."

# Source (profiles + test fixtures travel with apps/worker).
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN pnpm --filter @print/db generate

# Long-running BullMQ consumer (tsx runs the TS entrypoint directly).
CMD ["pnpm", "--filter", "@print/worker", "start"]
