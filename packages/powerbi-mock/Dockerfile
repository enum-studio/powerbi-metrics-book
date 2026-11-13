# syntax=docker/dockerfile:1
#
# The Power BI mock, for the dev compose file and the end-to-end tests. The
# build context is the repository root:
#
#   docker build -f packages/powerbi-mock/Dockerfile -t powerbi-mock .
#
# It reads PORT (default 3001), MOCK_ORIGIN (the origin it puts in token
# issuers and URLs, default http://localhost:PORT) and MOCK_CONTROL=1 (mounts
# the /_mock control routes).

FROM node:24-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS pnpm
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Corepack installs the pnpm that the root package.json pins.
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/powerbi-mock/package.json packages/powerbi-mock/

FROM pnpm AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter @powerbi-metrics-book/powerbi-mock
COPY tsconfig.base.json ./
COPY packages/powerbi-mock/ packages/powerbi-mock/
RUN pnpm --filter @powerbi-metrics-book/powerbi-mock build

# Only what the server imports at runtime: no TypeScript or vitest.
FROM pnpm AS runtime_deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --prod --filter @powerbi-metrics-book/powerbi-mock

FROM node:24-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d
ENV NODE_ENV=production PORT=3001
# A user of its own with no home, numeric so that a runtime can check it is not root.
RUN useradd --system --uid 10001 --user-group --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin mock
WORKDIR /app
COPY --from=runtime_deps /repo/node_modules node_modules
COPY --from=runtime_deps /repo/packages/powerbi-mock/node_modules packages/powerbi-mock/node_modules
COPY --from=build /repo/packages/powerbi-mock/dist packages/powerbi-mock/dist
COPY packages/powerbi-mock/package.json packages/powerbi-mock/
WORKDIR /app/packages/powerbi-mock
USER 10001:10001
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health`).then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/bin.js"]
