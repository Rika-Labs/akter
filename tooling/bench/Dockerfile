FROM oven/bun:1.4.2-debian
USER root
WORKDIR /repo
COPY source .
RUN bun install --frozen-lockfile --ignore-scripts
COPY harness ./tooling/bench/src
RUN mkdir -p tooling/bench/node_modules/@rikalabs && if [ ! -e tooling/bench/node_modules/@rikalabs/akter ]; then ln -s /repo/packages/akter tooling/bench/node_modules/@rikalabs/akter; fi
