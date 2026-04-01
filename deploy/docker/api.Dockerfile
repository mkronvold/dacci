FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/content-engine/package.json packages/content-engine/package.json
COPY packages/github-sync/package.json packages/github-sync/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json

RUN npm ci

COPY apps/api apps/api
COPY packages/content-engine packages/content-engine
COPY packages/github-sync packages/github-sync
COPY packages/shared-types packages/shared-types

RUN npm run build --workspace @dacci/shared-types \
  && npm run build --workspace @dacci/content-engine \
  && npm run build --workspace @dacci/github-sync \
  && npm run build --workspace @dacci/api

FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_ROOT=/workspace/data
ENV GIT_SYNC_REPO_ROOT=/workspace
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN git config --system --add safe.directory /workspace

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/content-engine/package.json packages/content-engine/package.json
COPY packages/github-sync/package.json packages/github-sync/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json

RUN npm ci --omit=dev

COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/packages/content-engine/dist packages/content-engine/dist
COPY --from=build /app/packages/github-sync/dist packages/github-sync/dist
COPY --from=build /app/packages/shared-types/dist packages/shared-types/dist

EXPOSE 3000

CMD ["npm", "run", "start", "--workspace", "@dacci/api"]
