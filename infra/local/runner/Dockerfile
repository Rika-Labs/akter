FROM oven/bun:1.4.2
WORKDIR /workspace
COPY . .
RUN bun install --frozen-lockfile --filter @rikalabs/akter \
  && mv infra/local/runner packages/akter/runner-example \
  && ln -s ../../packages/akter/runner-example infra/local/runner
ARG RUNNER_VERSION=dev
ENV RUNNER_VERSION=$RUNNER_VERSION
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "infra/local/runner/main.ts"]
