# ── Build stage ──────────────────────────────────────────────
FROM node:22-slim AS build

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json ./
COPY packages/ packages/

RUN pnpm install --frozen-lockfile
RUN pnpm build

# ── Runtime stage ───────────────────────────────────────────
FROM node:22-slim AS runtime

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app
COPY --from=build /app .

# Remove devDependencies
RUN pnpm prune --prod

ENV NODE_ENV=production
EXPOSE 3000 4000

ENTRYPOINT ["node", "packages/cli/dist/main.js"]
CMD ["start"]
