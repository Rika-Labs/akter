FROM node:26-slim
WORKDIR /app
COPY . /app
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000
ENTRYPOINT ["node", "/app/serve-node.mjs"]
