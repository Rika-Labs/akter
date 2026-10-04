FROM oven/bun:1.4.2
WORKDIR /workspace
COPY . .
RUN bun install --frozen-lockfile
CMD ["bun", "apps/edge/src/main.ts"]
