# syntax=docker/dockerfile:1.7
#
# Public Quintal office image — published as ghcr.io/joaoh82/quintal:<tag>.
#
# One Node process, one port, one volume. Multi-arch is handled by running this
# same Dockerfile on native amd64 and native arm64 runners (see
# .github/workflows/docker.yml). Do not add --platform pins: native
# @libsql/client bindings must match the image arch, and must never be copied
# from the host.

ARG NODE_VERSION=22
ARG DEBIAN_VERSION=bookworm

# ─── Stage 1: build ─────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-${DEBIAN_VERSION}-slim AS builder

WORKDIR /app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=true

RUN corepack enable && corepack prepare pnpm@11.0.9 --activate

# Manifests first so a source-only change does not reinstall.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY apps/website/package.json apps/website/
COPY packages/shared/package.json packages/shared/
COPY packages/acp-harness/package.json packages/acp-harness/

RUN pnpm install --frozen-lockfile

COPY . .

# Syncs the map assets and embeds the harness prompt as part of the workspace
# build. `output: 'standalone'` is not the shape this server uses —
# apps/server/src/http/next-app.ts boots Next from webDir and needs `next`
# resolvable from the pruned workspace node_modules.
RUN pnpm build
# Drop devDependencies for every workspace package. `pnpm prune --prod` at
# the workspace root only keeps the root package's graph, and the root does
# not depend on @quintal/server — that would empty apps/server/node_modules.
# --offline uses the store from the install above.
# typescript stays: it is a production dependency of @quintal/web because
# next.config.ts is evaluated at runtime by createNextApp.
RUN pnpm install --prod --frozen-lockfile --offline

# ─── Stage 2: runtime ───────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-${DEBIAN_VERSION}-slim AS runtime

# org.opencontainers.image.source is the load-bearing label — without it GHCR
# keeps the package private even when the repo is public.
LABEL org.opencontainers.image.title="Quintal" \
      org.opencontainers.image.description="A spatial office where your AI agents are visible teammates." \
      org.opencontainers.image.source="https://github.com/joaoh82/quintal" \
      org.opencontainers.image.url="https://github.com/joaoh82/quintal" \
      org.opencontainers.image.documentation="https://github.com/joaoh82/quintal/blob/main/SELF_HOSTING.md" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        openssl \
    && rm -rf /var/lib/apt/lists/* \
    && usermod --login quintal node \
    && groupmod --new-name quintal node

WORKDIR /app

COPY --from=builder --chown=quintal:quintal /app /app
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Named volume /data is a real disk that survives restarts, so local object
# storage is honest here. Production otherwise refuses file: storage — a
# container platform's filesystem does not survive a redeploy, and every
# avatar would vanish with it. See packages/shared/src/storage/config.ts.
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    QUINTAL_DATA_ROOT=/data \
    DATABASE_URL=file:/data/quintal.db \
    STORAGE_URL=file:/data/objects \
    STORAGE_ALLOW_LOCAL=1 \
    BETTER_AUTH_URL=http://localhost:3000

EXPOSE 3000

# Pre-created so a first-time named volume inherits quintal:quintal.
RUN mkdir -p /data && chown quintal:quintal /data
VOLUME /data

USER quintal:quintal

HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=12 \
    CMD curl -f http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
