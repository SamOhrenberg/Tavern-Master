# syntax=docker/dockerfile:1.7
# One image for both the web and the worker process (different commands).
ARG NODE_VERSION=22

# ---- all dependencies (build tools included) ----
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---- compile server and client ----
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build

# ---- production dependencies only ----
FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace @tavern/server --no-audit --no-fund \
 && rm -rf node_modules/onnxruntime-node/bin/napi-v*/darwin \
           node_modules/onnxruntime-node/bin/napi-v*/win32 \
           node_modules/@img/sharp-libvips-linuxmusl-* \
           node_modules/@img/sharp-linuxmusl-* \
 && find node_modules -name '*.map' -delete

# ---- runtime ----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIST=/app/web \
    HOST=0.0.0.0 \
    PORT=8080 \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./web
COPY apps/server/package.json ./apps/server/package.json
COPY apps/server/migrations ./apps/server/migrations
# The starter rules excerpt, read once when the library is empty.
COPY apps/server/seed ./apps/server/seed
COPY package.json ./package.json

# Writable state lives under /data only; the root filesystem can be read-only.
RUN mkdir -p /data/uploads /data/models && chown -R 1000:1000 /data
VOLUME ["/data/uploads", "/data/models"]

USER 1000:1000
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "apps/server/dist/main.js"]
