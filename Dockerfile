# syntax=docker/dockerfile:1

FROM node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS build
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ git \
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

FROM build AS check
RUN pnpm lint && pnpm typecheck && pnpm test

FROM node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates ffmpeg poppler-utils git \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 jarvis \
 && useradd --uid 10001 --gid jarvis --create-home --home-dir /home/jarvis --shell /usr/sbin/nologin jarvis \
 && mkdir -p /data /work /app/models \
 && chown jarvis:jarvis /data /work
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
ADD --checksum=sha256:98daf9bcf1c8abf3db374fec4c27a5eda7c58705bb3f180d057b085a72a88bb5 --chmod=644 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx \
  ./models/speaker.onnx
COPY assistant/CLAUDE.md assistant/loren.example.md ./assistant/
COPY infra/scripts/verify-claude-sdk.mjs ./scripts/
USER jarvis
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

FROM runtime AS video
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends libnss3 libdbus-1-3 libatk1.0-0t64 libatk-bridge2.0-0t64 libgbm1 libasound2t64 libxrandr2 libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 libpango-1.0-0 libcairo2 libcups2t64 fonts-noto-color-emoji fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
RUN node -e "import('@remotion/renderer').then((renderer) => renderer.ensureBrowser())"
COPY --from=build /src/packages/video/dist/bundle ./video-bundle
COPY infra/scripts/verify-video-render.mjs ./scripts/
ENV VIDEO_BUNDLE_DIR=/app/video-bundle \
    VIDEO_HEARTBEAT_FILE=/tmp/video-heartbeat
USER jarvis
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const t=Number(require('fs').readFileSync(process.env.VIDEO_HEARTBEAT_FILE,'utf8'));process.exit(Date.now()-t<120000?0:1)"]
CMD ["node", "dist/video-worker.js"]

FROM runtime AS agent-runner
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends git bubblewrap socat \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global --no-fund --no-audit pnpm@10.34.5
ENV WORK_DIR=/work \
    AGENT_HEARTBEAT_FILE=/tmp/agent-runner-heartbeat
USER jarvis
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const t=Number(require('fs').readFileSync(process.env.AGENT_HEARTBEAT_FILE,'utf8'));process.exit(Date.now()-t<60000?0:1)"]
CMD ["node", "dist/agent-runner.js"]
