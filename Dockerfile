# syntax=docker/dockerfile:1

FROM node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS build
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack install
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --offline
RUN pnpm -r build \
 && mkdir -p apps/web/dist
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm --filter @jarvis/server deploy --prod --legacy /out

FROM node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 jarvis \
 && useradd --uid 10001 --gid jarvis --create-home --home-dir /home/jarvis --shell /usr/sbin/nologin jarvis \
 && mkdir -p /data \
 && chown jarvis:jarvis /data
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    CLAUDE_CONFIG_DIR=/data/claude \
    ASSISTANT_DIR=/app/assistant \
    WEB_DIST_DIR=/app/web \
    HOME=/home/jarvis
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/web/dist ./web
COPY assistant/CLAUDE.md assistant/loren.example.md ./assistant/
COPY infra/scripts/verify-claude-sdk.mjs ./scripts/
USER jarvis
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
