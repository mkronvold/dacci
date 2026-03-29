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

COPY apps/web apps/web
COPY packages/shared-types packages/shared-types

RUN npm run build --workspace @dacci/shared-types \
  && npm run build --workspace @dacci/web

FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173
ENV WEB_API_BASE_URL=http://localhost:3000

COPY --from=build /app/apps/web/dist apps/web/dist
COPY apps/web/server.mjs apps/web/server.mjs

EXPOSE 4173

CMD ["node", "apps/web/server.mjs"]
