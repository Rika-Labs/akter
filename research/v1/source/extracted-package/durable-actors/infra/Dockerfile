# SETUP IMAGE ONLY. No actor server or health endpoint is implemented.
FROM oven/bun:1.3.0
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
CMD ["bun", "scripts/not-implemented.mjs", "runtime"]
