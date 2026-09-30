import { Actor, User } from "@durable-actors/core"
import { ActorCluster, type RunnerServices } from "@durable-actors/core/testing"
import { Context, Effect, Exit, Layer, type Redacted, Scope } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { threeRunners } from "../room/cluster.ts"
import { Room } from "../room/contract.ts"
import { RoomLive } from "../room/layer.ts"
import { ModerationApi, Moderators } from "../room/moderation.ts"

/** The tenant every request of the rehearsal is authenticated into. */
export const TENANT = "chat-rehearsal"

/**
 * Every provider call the moderation stand-in received, in order, with the
 * effect id it was keyed by. The rehearsal reads it to tell a retried call
 * from a repeated one.
 */
export const providerCalls: Array<{ readonly body: string; readonly key: string }> = []

const rooms = RoomLive.pipe(
  Layer.provide([
    Layer.succeed(ModerationApi, {
      check: (body, { idempotencyKey }) =>
        Effect.sync(() => {
          providerCalls.push({ body, key: idempotencyKey })

          return false
        }),
    }),
    Moderators.layer,
  ]),
)

/**
 * The chat routes as `main.ts` serves them, with the auth stand-in resolving
 * every bearer token into the rehearsal's tenant.
 */
const routes = Actor.serve({
  actors: [Room],
  auth: Actor.auth.make(() =>
    Effect.succeed({ tenant: TENANT, caller: User.make({ subject: "ada" }) }),
  ),
})

/** One runner's HTTP listener on a loopback port, and how to stop it. */
interface Listener {
  readonly port: number
  readonly stop: Effect.Effect<void>
}

/**
 * Three chat runners on one Postgres database, each with its own HTTP listener
 * serving `Actor.serve` over its own runtime, as three processes behind a load
 * balancer would. `close` stops the listeners and then the runners.
 */
export const deploy = Effect.fnUntraced(function* (database: Redacted.Redacted) {
  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(threeRunners({ database, actors: rooms }), scope)
  const cluster = Context.get(context, ActorCluster)
  const listeners = new Map<number, Listener>()

  const listen = Effect.fnUntraced(function* (runner: number) {
    const listener = yield* cluster.on(runner)(
      Effect.gen(function* () {
        const services = yield* Effect.context<RunnerServices>()

        const web = HttpRouter.toWebHandler(
          routes.pipe(Layer.provide(Layer.succeedContext(services))),
          { disableLogger: true },
        )

        const server = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch: (request) => web.handler(request),
        })

        return {
          port: server.port ?? 0,
          stop: Effect.promise(() => server.stop(true)).pipe(
            Effect.andThen(Effect.promise(() => web.dispose())),
          ),
        }
      }),
    )

    listeners.set(runner, listener)
  })

  const unlisten = Effect.fnUntraced(function* (runner: number) {
    yield* listeners.get(runner)?.stop ?? Effect.void
    listeners.delete(runner)
  })

  yield* cluster.ready
  yield* Effect.forEach([0, 1, 2], listen, { discard: true })

  return {
    cluster,
    listen,
    unlisten,
    /** The runners that currently have a listener, with their ports. */
    ports: () => [...listeners].map(([runner, { port }]) => ({ runner, port })),
    close: Effect.forEach([...listeners.keys()], unlisten, { discard: true }).pipe(
      Effect.andThen(Scope.close(scope, Exit.void)),
    ),
  }
})

export type Deployment = Effect.Success<ReturnType<typeof deploy>>
