import { createConnection, createServer, type AddressInfo, type Socket } from "node:net"
import { Context, type Duration, Effect, Layer, Schema, type Scope } from "effect"
import { HttpServer } from "effect/http"
import {
  Actor,
  ActorError,
  ActorUnavailable,
  isUser,
  Unauthorized,
  User,
} from "../../../../packages/akter/src/index.ts"
import { Akter, App, Auth, Store } from "../../../../packages/akter/src/server.ts"
import type { AuthRequest } from "../../../../packages/akter/src/server.ts"

/** A declared failure, so the suite can tell it from an `ActorError` on the wire. */
export class Over extends Schema.TaggedError<Over>()("Over", { limit: Schema.Finite }) {}

const Entry = Schema.Struct({ id: Schema.String, at: Schema.Finite, amount: Schema.Finite })

/** The suite's actor: a counter with a declared failure, a view, an event, a list and presence. */
export const Counter = Actor.make("Counter", {
  state: Schema.Struct({
    count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    online: Schema.Record(Schema.String, Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed({})),
    ),
    entries: Actor.list(Entry, { key: "id", by: "at" }),
  }),
  actions: {
    add: Actor.action(Schema.Finite, { success: Schema.Finite, fails: Over }),
    whoami: Actor.action({ success: Schema.String }),
  },
  views: { doubled: Actor.view(Schema.Finite) },
  events: { added: Actor.event(Schema.Finite) },
  presence: Schema.Struct({ name: Schema.String }),
  access: isUser,
})

/** The most a counter holds; an `add` past it fails with `Over`. */
export const LIMIT = 1_000

const CounterLive = Counter.toLayer({
  add: (counter, amount, { id, now, emit }) => {
    if (counter.count + amount > LIMIT) return Over.make({ limit: LIMIT })
    counter.count += amount
    counter.entries.put({ id: id(), at: now(), amount })
    emit.added(amount)
    return counter.count
  },
  whoami: (_, __, { caller }) => caller.subject,
  doubled: (counter) => counter.count * 2,
  connect: (counter, { name }, { connection }) => {
    counter.online[connection] = name
  },
  disconnect: (counter, _, { connection }) => {
    delete counter.online[connection]
  },
})

/** The app the suite serves. */
export const app = App.make({ actors: [Counter], layer: CounterLive })

/**
 * A bearer token is a subject, optionally followed by `~` and a version, so one caller can hold
 * several credentials. A revoked token is refused as invalid; while `unavailable` is set every
 * check fails as if the provider were unreachable.
 */
export const makeAuth = () => {
  const revoked = new Set<string>()
  const control = { revoked, unavailable: false }
  const provider = Auth.make((request: AuthRequest) =>
    Effect.gen(function* () {
      if (control.unavailable) return yield* ActorError.make({ reason: ActorUnavailable.make({}) })
      const header = request.credential ?? request.headers["authorization"]
      const token =
        header !== undefined && header.startsWith("Bearer ") ? header.slice(7) : undefined
      if (token === undefined)
        return yield* ActorError.make({
          reason: Unauthorized.make({ code: "missing_credentials" }),
        })
      if (revoked.has(token))
        return yield* ActorError.make({
          reason: Unauthorized.make({ code: "invalid_credentials" }),
        })
      return { caller: User.make({ subject: token.split("~")[0] ?? token }), tenant: "default" }
    }),
  )
  return { provider, control }
}

/**
 * Serves the app on a free loopback port over an in-memory store until the scope closes, and
 * answers the port.
 */
export const serve = (options: {
  readonly auth: ReturnType<typeof makeAuth>["provider"]
  readonly reauthorizeEvery?: Duration.Input
  readonly origins?: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Akter.serve({
        app,
        auth: options.auth,
        port: 0,
        hostname: "127.0.0.1",
        reauthorizeEvery: options.reauthorizeEvery ?? "60 seconds",
        origins: options.origins,
      }).pipe(Layer.provide(Store.memory())),
    )
    const address = Context.get(context, HttpServer.HttpServer).address
    return "port" in address ? address.port : yield* Effect.die(new Error("no TCP address"))
  })

/**
 * A TCP proxy in front of a server. `cut()` makes it drop the next connection whose server bytes
 * carry an RPC exit before relaying them: the server has answered, the client never hears it.
 * `sever()` destroys every open connection at once; `connections()` counts those accepted.
 */
export const lossyProxy = (
  target: number,
): Effect.Effect<
  {
    readonly port: number
    readonly cut: () => void
    readonly sever: () => void
    readonly cuts: () => number
    readonly connections: () => number
  },
  never,
  Scope.Scope
> =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly server: ReturnType<typeof createServer>
      readonly sockets: Set<Socket>
      readonly port: number
      readonly state: { armed: boolean; cuts: number; connections: number }
    }>((resume) => {
      const sockets = new Set<Socket>()
      const state = { armed: false, cuts: 0, connections: 0 }
      const server = createServer((client) => {
        state.connections++
        const upstream = createConnection({ host: "127.0.0.1", port: target })
        sockets.add(client)
        sockets.add(upstream)
        const close = () => {
          client.destroy()
          upstream.destroy()
          sockets.delete(client)
          sockets.delete(upstream)
        }
        client.on("error", close)
        upstream.on("error", close)
        client.on("close", close)
        upstream.on("close", close)
        client.on("data", (chunk) => upstream.write(chunk))
        upstream.on("data", (chunk: Buffer) => {
          if (state.armed && chunk.includes('"_tag":"Exit"')) {
            state.armed = false
            state.cuts++
            close()
            return
          }
          client.write(chunk)
        })
      })
      server.listen(0, "127.0.0.1", () =>
        resume(
          Effect.succeed({
            server,
            sockets,
            port: (server.address() as AddressInfo).port,
            state,
          }),
        ),
      )
    }),
    ({ server, sockets }) =>
      Effect.callback<void>((resume) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resume(Effect.void))
      }),
  ).pipe(
    Effect.map(({ port, sockets, state }) => ({
      port,
      cut: () => {
        state.armed = true
      },
      sever: () => {
        for (const socket of sockets) socket.destroy()
        sockets.clear()
      },
      cuts: () => state.cuts,
      connections: () => state.connections,
    })),
  )
