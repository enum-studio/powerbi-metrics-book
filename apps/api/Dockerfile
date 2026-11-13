# syntax=docker/dockerfile:1
#
# The image: one, tagged powerbi-metrics-book. Started with `api`, `worker` or
# `server <command>` (the entry point, dist/cli-entry.js). The build context is
# the repository root:
#
#   docker build -f apps/api/Dockerfile --build-arg GIT_SHA=$(git rev-parse HEAD) \
#     -t powerbi-metrics-book .
#
# Dockerfile.dockerignore beside this file keeps the context to what the
# build copies. Without GIT_SHA the build reads the commit from .git, for a host
# that deploys a fresh clone and cannot pass one (Dokploy refuses a shell
# substitution in its compose command). With neither, the image builds, and the
# api and the worker refuse to start, naming it.

# Node 24, pinned by digest; a new Node release is a reviewed change here.
FROM node:24-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS node

FROM node AS pnpm
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Corepack installs the pnpm that the root package.json pins.
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
# The api's tests start the mock, so the workspace links it.
COPY packages/powerbi-mock/package.json packages/powerbi-mock/

FROM pnpm AS build
# The root manifest holds typescript, which builds the api.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter @powerbi-metrics-book/api --filter .
COPY tsconfig.base.json ./
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/
COPY apps/api/src apps/api/src
RUN pnpm --filter @powerbi-metrics-book/api build

# The SPA the api serves at /: its build is static files, so nothing of this
# stage but apps/web/dist reaches the image.
FROM pnpm AS web
COPY apps/web/package.json apps/web/
COPY packages/tokens/package.json packages/tokens/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter @powerbi-metrics-book/web...
COPY packages/tokens/tokens.css packages/tokens/theme.css packages/tokens/fonts.css \
  packages/tokens/mark.svg packages/tokens/tile.svg packages/tokens/
COPY apps/web/index.html apps/web/vite.config.ts apps/web/
COPY apps/web/src apps/web/src
RUN pnpm --filter @powerbi-metrics-book/web build

# The docs the api serves at /docs: static files as well. The build copies three
# of the repository's own documents into the site (sync-repo-docs.mjs), so they
# come into the stage with it.
FROM pnpm AS docs
COPY apps/docs/package.json apps/docs/
COPY packages/tokens/package.json packages/tokens/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter @powerbi-metrics-book/docs...
COPY packages/tokens/tokens.css packages/tokens/theme.css packages/tokens/fonts.css \
  packages/tokens/mark.svg packages/tokens/tile.svg packages/tokens/
COPY SECURITY.md CHANGELOG.md ./
COPY docs/security/threat_model.md docs/security/
COPY apps/docs/astro.config.mjs apps/docs/
COPY apps/docs/scripts/sync-repo-docs.mjs apps/docs/scripts/
COPY apps/docs/src apps/docs/src
COPY apps/docs/public apps/docs/public
RUN pnpm --filter @powerbi-metrics-book/docs build

# Only what the api imports at runtime: no TypeScript, vitest or drizzle-kit.
# pnpm resolves better-auth's optional peers (drizzle-kit, vitest, react) from
# the workspace and records them as optional dependencies, which pull in tsx and
# esbuild; --no-optional leaves them out. It relies on pnpm hoisting better-auth's
# drizzle-orm and pg through node_modules/.pnpm/node_modules, so a narrower
# hoist-pattern breaks sign-in.
FROM pnpm AS runtime_deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --prod --no-optional --filter @powerbi-metrics-book/api

# The commit HEAD names, by a loose ref, a packed ref or directly. A context with
# no .git directory (a worktree's .git is a file, and is ignored) leaves the file
# empty. package.json is there because COPY needs one source that matches. The
# paths are named, so .git/config stays out even if a builder skips the ignore
# file: a host's clone can hold its token there.
FROM node AS commit
WORKDIR /git
COPY package.json .gi[t]/HEAD .gi[t]/packed-refs ./
COPY package.json .gi[t]/refs/heads/ refs/heads/
RUN touch /git_sha; \
  if [ -f HEAD ]; then \
    head=$(cat HEAD); ref=${head#ref: }; \
    if [ "$ref" = "$head" ]; then echo "$head"; \
    elif [ -f "$ref" ]; then cat "$ref"; \
    elif [ -f packed-refs ]; then awk -v r="$ref" '$2 == r { print $1 }' packed-refs; fi > /git_sha; \
  fi

FROM node
ARG GIT_SHA
ENV NODE_ENV=production \
  GIT_SHA=$GIT_SHA \
  GIT_SHA_FILE=/app/git_sha \
  PORT=3000 \
  LOG_LEVEL=info
# A user of its own with no home, rather than the image's node user, whose
# home is writable; with /var/tmp and /run/lock closed too, /tmp is the one
# place it can write. Numeric, so a runtime can check it is not root. The
# identity directory is its own, so a new volume mounted there starts out
# writable by it.
RUN useradd --system --uid 10001 --user-group --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin pbmb \
  && chmod o-w /var/tmp /run/lock \
  && install --directory --owner 10001 --group 10001 --mode 0700 /var/lib/pbmb/identity
# The api is started with node alone. The package managers that ship in the base
# image (npm, yarn, corepack) carry dependencies of their own, which a scanner
# reports, so they are left out.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
  /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*
# `docker compose exec api server setup-link`, as the docs say: exec skips the
# entry point, so `server` is a command on PATH of its own.
RUN printf '#!/bin/sh\nexec node /app/apps/api/dist/cli-entry.js server "$@"\n' > /usr/local/bin/server \
  && chmod 0755 /usr/local/bin/server
# The repository's layout is kept, so a path the code builds from its own
# location holds in the image as in a checkout: apps/api/node_modules links
# into the root node_modules/.pnpm. Every file stays root's.
WORKDIR /app
COPY --from=runtime_deps /repo/node_modules node_modules
COPY --from=runtime_deps /repo/apps/api/node_modules apps/api/node_modules
COPY --from=build /repo/apps/api/dist apps/api/dist
# Where src/http/static.ts finds it, beside apps/api as in the checkout.
COPY --from=web /repo/apps/web/dist apps/web/dist
# Where src/http/docs.ts finds it.
COPY --from=docs /repo/apps/docs/dist apps/docs/dist
COPY apps/api/package.json apps/api/
# Beside dist, as in the checkout: src/db/migrate.ts reads both. tsc copies no
# .sql file.
COPY apps/api/drizzle apps/api/drizzle
COPY apps/api/src/db/sql apps/api/src/db/sql
# Cerbos mounts the default policies from this image (stack/compose.yml reads
# app/access/policies), and the conventions service reads its presets.
COPY access/policies access/policies
COPY conventions/presets conventions/presets
COPY --from=commit /git_sha git_sha
WORKDIR /app/apps/api
USER 10001:10001
EXPOSE 3000
# The compose file gives each service its command and its health check; the
# api and the worker prove they are alive in different ways.
ENTRYPOINT ["node", "dist/cli-entry.js"]
