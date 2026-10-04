import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net"
import * as zlib from "node:zlib"
import { Context, Effect, Layer, Stream, type Scope } from "effect"
import type { Crypto } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"

/** Whether this process runs on Bun, whose native server and platform layers are faster than Node's. */
export const onBun = typeof Bun !== "undefined"

/**
 * The runtime's `Crypto` service. The platform package is imported when the
 * layer builds, so a Node process never loads Bun's package and a Bun process
 * never loads Node's.
 */
export const cryptoLayer: Layer.Layer<Crypto.Crypto> = Layer.unwrap(
  Effect.promise(() =>
    onBun
      ? import("@effect/platform-bun/BunCrypto").then((platform) => platform.layer)
      : import("@effect/platform-node/NodeCrypto").then((platform) => platform.layer),
  ),
)

/** A listening `HttpServer` on a free loopback port, from the running platform's package. */
export const httpServerLayer: Layer.Layer<HttpServer.HttpServer> = Layer.orDie(
  Layer.unwrap(
    Effect.promise(() =>
      onBun
        ? import("@effect/platform-bun/BunHttpServer").then((platform) =>
            platform.layerServer({ hostname: "127.0.0.1", port: 0 }),
          )
        : Promise.all([import("node:http"), import("@effect/platform-node/NodeHttpServer")]).then(
            ([http, platform]) =>
              platform.layerServer(http.createServer, { host: "127.0.0.1", port: 0 }),
          ),
    ),
  ),
)

/**
 * Serves `fetch` through Effect's `HttpServer` on Node, which streams request
 * and response bodies. The request's URL takes its scheme from the plain
 * listening socket and its host from `Host`, never from a forwarded header, as
 * Bun's server does.
 */
const serveOnNode = (fetch: (request: Request) => Response | Promise<Response>) =>
  Effect.gen(function* () {
    const { createServer } = yield* Effect.promise(() => import("node:http"))
    const platform = yield* Effect.promise(() => import("@effect/platform-node/NodeHttpServer"))

    const server = Context.get(
      yield* Layer.build(platform.layerServer(createServer, { host: "127.0.0.1", port: 0 })),
      HttpServer.HttpServer,
    )

    yield* server.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const context = yield* Effect.context<never>()
        const init: RequestInit & { duplex?: "half" } = {
          method: request.method,
          headers: request.headers,
        }

        if (request.method !== "GET" && request.method !== "HEAD") {
          init.body = Stream.toReadableStreamWith(request.stream, context)
          init.duplex = "half"
        }

        const web = new Request(
          new URL(request.url, `http://${request.headers.host ?? "localhost"}`),
          init,
        )

        return HttpServerResponse.fromWeb(yield* Effect.promise(() => Promise.resolve(fetch(web))))
      }).pipe(Effect.orDie),
    )

    const address = server.address

    return "port" in address ? address.port : yield* Effect.die(new Error("No listening port"))
  }).pipe(Effect.orDie)

/**
 * Serves a web `fetch` handler from a real listening loopback server until
 * the scope closes, and answers its port. Bun serves it natively; Node serves
 * it through Effect's `HttpServer`.
 */
export const serveFetch = (
  fetch: (request: Request) => Response | Promise<Response>,
): Effect.Effect<number, never, Scope.Scope> => {
  if (!onBun) return serveOnNode(fetch)

  return Effect.acquireRelease(
    Effect.sync(() => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch })),
    (server) => Effect.promise(() => server.stop(true)),
  ).pipe(Effect.map((server) => server.port!))
}

/**
 * A loopback TCP port that accepts connections and never answers, until the
 * scope closes: a runner that is reachable but hung.
 */
export const silentListener: Effect.Effect<number, never, Scope.Scope> = Effect.acquireRelease(
  Effect.callback<{
    readonly server: ReturnType<typeof createTcpServer>
    readonly sockets: ReadonlySet<Socket>
    readonly port: number
  }>((resume) => {
    const sockets = new Set<Socket>()

    const server = createTcpServer((socket) => {
      sockets.add(socket)
      socket.on("error", () => undefined)
      socket.on("data", () => undefined)
      socket.once("close", () => sockets.delete(socket))
    })

    server.listen(0, "127.0.0.1", () =>
      resume(Effect.succeed({ server, sockets, port: (server.address() as AddressInfo).port })),
    )
  }),
  ({ server, sockets }) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void))
      sockets.forEach((socket) => socket.destroy())
    }),
).pipe(Effect.map(({ port }) => port))

/** Decompresses a zstd frame: Bun's native decoder when it runs, Node's `zlib` otherwise. */
export const zstdDecompress = (bytes: Uint8Array): Uint8Array =>
  onBun ? Bun.zstdDecompressSync(bytes) : zlib.zstdDecompressSync(bytes)

/** How a process ended: its exit code, or the signal that killed it. */
export interface Exit {
  readonly code: number | null
  readonly signal: string | null
}

/**
 * Runs a TypeScript fixture in its own process on the runtime that runs the
 * suite: Bun runs the file as is and Node strips its types, so the sources it loads may use only erasable syntax. The scope
 * SIGKILLs the process if it still runs.
 */
export const spawnFixture = Effect.fnUntraced(function* (
  script: URL,
  env: Readonly<Record<string, string>>,
) {
  const child = yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const { spawn } = yield* Effect.promise(() => import("node:child_process"))
      const { fileURLToPath } = yield* Effect.promise(() => import("node:url"))

      return spawn(process.execPath, [fileURLToPath(script)], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "inherit"],
      })
    }),
    (spawned) =>
      Effect.sync(() => {
        spawned.kill("SIGKILL")
      }),
  )

  const stdout: AsyncIterable<Uint8Array> = child.stdout

  return {
    stdout: Stream.fromAsyncIterable(stdout, () => "unreadable" as const),
    kill: Effect.callback<Exit>((resume) => {
      if (child.exitCode !== null || child.signalCode !== null)
        return resume(Effect.succeed({ code: child.exitCode, signal: child.signalCode }))

      child.once("exit", (code, signal) => resume(Effect.succeed({ code, signal })))
      child.kill("SIGKILL")
    }),
  }
})
