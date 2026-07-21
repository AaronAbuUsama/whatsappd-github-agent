# Tenant runtime image. One image, two entrypoints selected by the provisioner's
# command override (apps/api/src/provisioner.ts):
#   setup:   node dist/cli/setup.js
#   operate: node dist/cli/main.js --data-dir <dir> start --log-format json
# Build context is the repo root: docker build -f apps/runtime/Dockerfile .

FROM node:24-slim AS build
# vp pack is a Rust binary that needs system CA certificates, which slim omits.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /src
ENV SKIP_ENV_VALIDATION=1
COPY . .
RUN --mount=type=cache,target=/pnpm-store pnpm install --store-dir /pnpm-store
# prepack runs build:dist (flue build for dist/server.mjs + vp pack for dist/cli/*),
# producing the same tarball tests/packaging/packed-cli.test.ts installs and drives.
RUN pnpm pack --pack-destination /out

FROM node:24-slim
COPY --from=build /out/ /tmp/pack/
RUN npm install -g /tmp/pack/*.tgz && rm -r /tmp/pack
# The provisioner issues relative entrypoint paths and an in-container CMD-SHELL
# healthcheck (`node -e "fetch(...)"`), so node stays on PATH and cwd is the package.
WORKDIR /usr/local/lib/node_modules/ambient-agent
EXPOSE 3000
CMD ["node", "dist/cli/setup.js"]
