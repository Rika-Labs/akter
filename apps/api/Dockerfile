FROM oven/bun:1.4.2
RUN apt-get update && apt-get install -y --no-install-recommends docker-cli docker-buildx && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY . .
RUN bun install --frozen-lockfile
CMD ["bun", "--watch", "apps/api/src/main.ts"]
