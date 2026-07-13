# syntax=docker/dockerfile:1
# Build context: packages/git-flow-deploy-service/.docker-staging
# Staging dir is prepared by the github.actions.build wireit task via pnpm deploy.

FROM node:24-alpine
WORKDIR /app
COPY . .

LABEL org.opencontainers.image.title="git-flow-deploy-service"
LABEL org.opencontainers.image.description="Deploy gateway service for git-flow"
LABEL org.opencontainers.image.source="https://github.com/cpdevtools/git-flow"

ENV PORT=3700
EXPOSE 3700

CMD ["node", "dist/main"]
