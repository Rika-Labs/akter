FROM oven/bun:1.4.2
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
ENV NODE_ENV=production PORT=3001
USER bun
EXPOSE 3001
CMD ["bun", "--filter", "@durable-actors/api", "start"]
