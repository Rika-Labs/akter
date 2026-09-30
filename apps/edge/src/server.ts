import { InvalidInput, SUBPROTOCOL } from "@durable-actors/core"
import type { Server } from "bun"
import { Crypto, Effect, Encoding, Layer, Predicate, Queue, Result } from "effect"
import { HttpClient } from "effect/unstable/http"
import type { EdgeOptions } from "./config.ts"
import { authenticator } from "./principals/authenticate.ts"
import { directory } from "./routing/directory.ts"
import { type Edge, forward, refusal } from "./routing/forward.ts"
import { hostOf, hosts } from "./routing/hosts.ts"
import { runners } from "./routing/runners.ts"
import { keyRing } from "./signing/keys.ts"
import { revocationPush } from "./signing/revocation.ts"
import { Inbound, proxySocket, type SocketData } from "./sockets/proxy.ts"

const utf8 = new TextEncoder()

/** The close code for a client that sends past its socket buffer. */
const POLICY_VIOLATION = 1008

const offeredFirst = (request: Request) =>
  (request.headers.get("sec-websocket-protocol") ?? "").split(",")[0]?.trim() === SUBPROTOCOL

const isUpgrade = (request: Request) =>
  request.headers.get("upgrade")?.toLowerCase() === "websocket" && offeredFirst(request)

/**
 * The hosted edge: maps each request's host to a deployment, authenticates it,
 * and forwards it with a signed assertion to a ready runner of the tenant's
 * home region. Listens until the scope closes.
 *
 * An unknown host is refused before anything is authenticated.
 */
export const makeEdge = Effect.fnUntraced(function* (options: EdgeOptions) {
  const random = yield* Crypto.Crypto

  const client = yield* HttpClient.HttpClient
  const keys = yield* keyRing(options)

  yield* revocationPush(options, keys, client)

  const pool = yield* runners(options, client)

  const edge: Edge = {
    options,
    client,
    keys,
    authenticator: yield* authenticator(options),
    resolveHost: (yield* hosts(options)).resolve,
    home: (yield* directory(options)).home,
    ready: pool.ready,
    coldStart: pool.coldStart,
  }

  const run = Effect.runPromiseWith(yield* Effect.context<never>())

  const handle = (request: Request, server: Server<SocketData>) =>
    Effect.gen(function* () {
      const url = new URL(request.url)
      const deployment = yield* edge.resolveHost(hostOf(request.headers.get("host") ?? url.host))

      if (deployment === undefined)
        return yield* refusal(InvalidInput.make({ code: "unknown_route" }))

      if (!isUpgrade(request)) return yield* forward(edge, deployment, request)

      const credential = request.headers.get("authorization")
      let upgrade: SocketData["upgrade"]

      if (credential !== null) {
        const proved = yield* edge.authenticator
          .authenticate({ deployment: deployment.id, credential })
          .pipe(Effect.result)

        if (Result.isFailure(proved)) return yield* refusal(proved.failure)
        upgrade = proved.success
      }

      const session = Encoding.encodeBase64Url(yield* random.randomBytes(16).pipe(Effect.orDie))

      const data: SocketData = {
        deployment,
        target: `${url.pathname}${url.search}`,
        session,
        upgrade,
        inbox: yield* Queue.unbounded<Inbound>(),
        pending: 0,
      }

      if (server.upgrade(request, { data, headers: { "sec-websocket-protocol": SUBPROTOCOL } }))
        return undefined

      return yield* refusal(InvalidInput.make({ code: "unsupported_protocol" }))
    })

  const server = Bun.serve<SocketData>({
    hostname: options.hostname,
    port: options.port,
    fetch: (request, served) => run(handle(request, served)),
    websocket: {
      maxPayloadLength: options.socketMessageBytes,
      open: (ws) => void run(proxySocket(edge, ws)),
      message: (ws, message) => {
        const data = Predicate.isString(message) ? message : new Uint8Array(message)
        const bytes = Predicate.isString(data) ? utf8.encode(data).byteLength : data.byteLength

        ws.data.pending += bytes

        if (ws.data.pending > options.socketBufferBytes) {
          ws.close(POLICY_VIOLATION, "Client sent faster than its runner reads")

          return
        }

        Queue.offerUnsafe(ws.data.inbox, Inbound.Message({ data, bytes }))
      },
      close: (ws) => {
        Queue.offerUnsafe(ws.data.inbox, Inbound.Closed())
      },
    },
  })

  yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
  yield* Effect.log(`Edge listening on ${server.hostname}:${server.port}`)

  return { url: `http://${server.hostname}:${server.port}`, port: server.port ?? 0 }
})

/** The edge as a layer: it listens while the layer is alive. */
export const EdgeLive = (options: EdgeOptions) => Layer.effectDiscard(makeEdge(options))
