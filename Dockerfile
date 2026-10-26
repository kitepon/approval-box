# Node release assets are verified with the committed signed checksums/keyring.
# Pin the multi-platform Bookworm index; the old Node in this base is replaced.
ARG NODE_BASE=node:24-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4
FROM --platform=$BUILDPLATFORM ${NODE_BASE} AS node-release
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gpgv xz-utils \
 && rm -rf /var/lib/apt/lists/*
COPY tools/deploy/node-release/ /release/
ARG TARGETARCH
RUN sh /release/install.sh "$TARGETARCH"

FROM ${NODE_BASE} AS verified-node
USER root
RUN rm -rf /usr/local/bin/node /usr/local/bin/nodejs /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/include/node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack
COPY --from=node-release /verified-node/ /usr/local/
ENV NODE_VERSION=24.22.1
RUN test "$(node --version)" = "v24.22.1" && test "$(npm --version)" = "11.21.1"

# Approval Box サーバー（Web版を同梱）。docker compose up -d で受信画面まで揃う。
FROM verified-node AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/connector/package.json packages/connector/
RUN npm ci --no-audit --no-fund
COPY packages/server packages/server
COPY packages/web packages/web
RUN npm run build -w packages/server -w packages/web \
 && npm prune --omit=dev --no-audit --no-fund

FROM verified-node AS runtime
ENV NODE_ENV=production PORT=8787 APPROVAL_BOX_DATA=/data APPROVAL_BOX_WEB=/app/web
WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages/server/package.json ./server/package.json
COPY --from=build /src/packages/server/dist ./server/dist
COPY --from=build /src/packages/server/certs ./server/certs
COPY --from=build /src/packages/web/dist ./web
# 入口。SECRETS_DIR を指定した時だけ、環境変数で受け取った鍵を tmpfs のファイルへ移してから起こす。
COPY --chmod=755 tools/deploy/start-with-secrets.sh /app/start-with-secrets.sh
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["/app/start-with-secrets.sh"]
CMD ["node", "server/dist/main.js"]

# CI uses the same verified runtime; test tools stay out of the product image.
FROM verified-node AS checks
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/ packages/
COPY tools/deploy/start-with-secrets.sh tools/deploy/start-with-secrets.sh
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
RUN npm ci --no-audit --no-fund
RUN npm run typecheck && npm run build
RUN node --test --test-force-exit --test-timeout=15000 packages/server/test/*.test.ts

FROM runtime AS final
