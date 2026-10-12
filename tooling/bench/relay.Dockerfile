FROM oven/bun:1.4.2-debian
USER root
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 && rm -rf /var/lib/apt/lists/*
COPY src/relay.ts /relay.ts
CMD ["bun", "/relay.ts"]
