FROM node:24-bookworm-slim AS build

WORKDIR /app
ENV COREPACK_HOME=/corepack
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages ./packages
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm db:generate
RUN pnpm --filter @signalforge/worker... build
RUN mkdir -p /ms-playwright \
  && pnpm --filter @signalforge/extraction exec playwright install --with-deps chromium
RUN pnpm --filter @signalforge/worker --prod deploy /opt/signalforge

FROM node:24-bookworm-slim AS runner

WORKDIR /opt/signalforge
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build --chown=node:node /opt/signalforge ./
COPY --from=build --chown=node:node /ms-playwright /ms-playwright
USER node

EXPOSE 9464
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9464/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
