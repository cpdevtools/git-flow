# syntax=docker/dockerfile:1
# Build context: monorepo root (git-flow/)
# Usage from repo root:
#   docker build -f packages/git-flow-deploy-service/Dockerfile \
#     -t git-flow-deploy-service:latest .

FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack install -g pnpm@11.5.0

# ─── deps ──────────────────────────────────────────────────────────────────────
# Install only the packages needed for the deploy service and its workspace dep.
FROM base AS deps
WORKDIR /workspace
COPY .npmrc package.json pnpm-workspace.yaml pnpm-lock.yaml ./
# Declare all workspace package manifests so pnpm resolves the graph correctly.
COPY packages/git-flow/package.json            ./packages/git-flow/
COPY packages/git-flow-cli/package.json        ./packages/git-flow-cli/
COPY packages/git-flow-deploy/package.json     ./packages/git-flow-deploy/
COPY packages/git-flow-deploy-cli/package.json ./packages/git-flow-deploy-cli/
COPY packages/git-flow-deploy-service/package.json ./packages/git-flow-deploy-service/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ─── build ─────────────────────────────────────────────────────────────────────
FROM base AS build
WORKDIR /workspace
COPY --from=deps /workspace/node_modules         ./node_modules
COPY --from=deps /workspace/packages             ./packages
# Copy source for the two packages we need to build.
COPY packages/git-flow-deploy     ./packages/git-flow-deploy/
COPY packages/git-flow-deploy-service ./packages/git-flow-deploy-service/
# Build the library dep first, then the NestJS service.
RUN pnpm --filter @cpdevtools/git-flow-deploy build
RUN pnpm --filter @cpdevtools/git-flow-deploy-service build

# Produce a standalone production deployment tree (resolves workspace:* deps).
RUN pnpm deploy --filter @cpdevtools/git-flow-deploy-service --prod /deploy

# ─── production ────────────────────────────────────────────────────────────────
FROM node:24-alpine AS production
WORKDIR /app

# node_modules from pnpm deploy (workspace deps resolved + only prod deps).
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /deploy/package.json ./

# Built dist — copy separately because dist/ is gitignored and excluded from
# the pnpm deploy output.
COPY --from=build /workspace/packages/git-flow-deploy-service/dist ./dist

LABEL org.opencontainers.image.title="git-flow-deploy-service"
LABEL org.opencontainers.image.description="Deploy gateway service for git-flow"
LABEL org.opencontainers.image.source="https://github.com/cpdevtools/git-flow"

ENV PORT=3700
EXPOSE 3700

CMD ["node", "dist/main"]
