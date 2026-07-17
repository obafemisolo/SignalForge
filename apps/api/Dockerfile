FROM node:22-bookworm-slim AS build

WORKDIR /app
ENV COREPACK_HOME=/corepack
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages ./packages
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm db:generate
RUN pnpm --filter @signalforge/api... build
RUN pnpm deploy --filter @signalforge/api --prod /opt/signalforge

FROM build AS migrate
CMD ["pnpm", "--filter", "@signalforge/database", "db:migrate:deploy"]

FROM node:22-bookworm-slim AS runner

WORKDIR /opt/signalforge
ENV NODE_ENV=production
COPY --from=build --chown=node:node /opt/signalforge ./
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
