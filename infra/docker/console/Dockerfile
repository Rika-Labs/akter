FROM oven/bun:1.4.2
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run build --filter @durable-actors/console
ENV NODE_ENV=production PORT=3000
USER bun
EXPOSE 3000
CMD ["bun", "--filter", "@durable-actors/console", "start"]
