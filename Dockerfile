# Approval Box サーバー（Web版を同梱）。docker compose up -d で受信画面まで揃う。
FROM node:24-slim AS build
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

FROM node:24-slim
ENV NODE_ENV=production PORT=8787 APPROVAL_BOX_DATA=/data APPROVAL_BOX_WEB=/app/web
WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages/server/package.json ./server/package.json
COPY --from=build /src/packages/server/dist ./server/dist
COPY --from=build /src/packages/web/dist ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
CMD ["node", "server/dist/main.js"]
