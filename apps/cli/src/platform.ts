import { createServer } from "node:http"

const platform =
  typeof Bun === "undefined"
    ? await import("@effect/platform-node").then((node) => ({
        crypto: node.NodeCrypto.layer,
        services: node.NodeServices.layer,
        runMain: node.NodeRuntime.runMain,
        httpServer: (options: { readonly port: number; readonly hostname: string }) =>
          node.NodeHttpServer.layer(createServer, { port: options.port, host: options.hostname }),
      }))
    : await import("@effect/platform-bun").then((bun) => ({
        crypto: bun.BunCrypto.layer,
        services: bun.BunServices.layer,
        runMain: bun.BunRuntime.runMain,
        httpServer: (options: { readonly port: number; readonly hostname: string }) =>
          bun.BunHttpServer.layer(options),
      }))

export const PlatformCrypto = { layer: platform.crypto }
export const PlatformServices = { layer: platform.services }
export const PlatformRuntime = { runMain: platform.runMain }
/** The Node HTTP layer requires node:http's server factory rather than a client-only Effect API. */
export const PlatformHttpServer = { layer: platform.httpServer }
