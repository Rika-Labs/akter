FROM node:26.7.0-bookworm-slim AS node

FROM oven/bun:1.4.2-debian
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates jq curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && git config --system --add safe.directory '*'
