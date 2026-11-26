# syntax=docker/dockerfile:1
#
# powerbimetricsbook.io: the landing page and the public docs, built into
# static files and served by Caddy on port 8080. Dokploy builds it from the
# repository root on every push to main:
#
#   docker build -f apps/site/Dockerfile -t powerbimetricsbook .
#
# Dockerfile.dockerignore beside this file keeps the context to what the
# build copies.

# Node 24, pinned by digest, the same as the api's image.
FROM node:24-trixie-slim@sha256:4d00acb4bcc42c454c4eb801526f7ad7f772ea3bd4fd168c5cc2e384abcbb9d4 AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Corepack installs the pnpm that the root package.json pins.
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/site/package.json apps/site/
COPY apps/docs/package.json apps/docs/
COPY packages/tokens/package.json packages/tokens/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile \
  --filter @powerbi-metrics-book/site... --filter @powerbi-metrics-book/docs...
COPY packages/tokens packages/tokens
# The docs build copies three of the repository's own documents into the
# site (sync-repo-docs.mjs), so they come into the stage with it.
COPY SECURITY.md CHANGELOG.md ./
COPY docs/security/threat_model.md docs/security/
COPY apps/docs apps/docs
COPY apps/site apps/site
# A broken link fails the build, so it never reaches the live site.
RUN pnpm --filter @powerbi-metrics-book/site build \
  && pnpm --filter @powerbi-metrics-book/site check

# The same Caddy as the VM guide's proxy (deploy/vm/compose.caddy.yml).
FROM caddy:2.11.7@sha256:504a44d7d74bd2bc28a66afc4774912fc21223ca8a67734af1c54ab2f999b489
COPY apps/site/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/site/dist /srv
# Caddy needs no state: no admin API, no certificates, no saved config.
ENV XDG_CONFIG_HOME=/tmp XDG_DATA_HOME=/tmp
USER 65534:65534
EXPOSE 8080
