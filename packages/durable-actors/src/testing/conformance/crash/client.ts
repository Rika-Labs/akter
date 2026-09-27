import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Redacted } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Actor } from "../../../index.ts"
import { Actors, Database } from "../../../runtime/index.ts"
import { TurnHooks } from "../../../runtime/turn/hooks.ts"
import { Incremented, ServedCounter } from "./client-actor.ts"

const CounterLive = ServedCounter.toLayer(
  Effect.succeed({
    Increment: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* ServedCounter.Turn
      yield* turn.state.set({ count: turn.state.count + amount })
      yield* turn.emit(Incremented.make({ count: turn.state.count }))

      return turn.state.count
    }),
  }),
)

const program = Effect.gen(function* () {
  const mode = yield* Config.String("CRASH_POINT")
  const database = yield* Config.String("CRASH_DATABASE_URL")
  const port = yield* Config.Int("CRASH_PORT")

  const hooks = Layer.succeed(TurnHooks, {
    at: (point) =>
      point === mode ? Console.log("READY").pipe(Effect.andThen(Effect.never)) : Effect.void,
  })

  const runtime = CounterLive.pipe(
    Layer.provideMerge(
      Actors.layer({ authorize: () => Effect.succeed(true) }).pipe(Layer.provide(hooks)),
    ),
    Layer.provideMerge(Database.postgres({ url: Redacted.make(database) })),
    Layer.provide(BunCrypto.layer),
  )

  const app = Actor.serve({ actors: [ServedCounter], auth: Actor.auth.none }).pipe(
    Layer.provide(runtime),
  )

  // The first request waits for the runtime, so a restarted process never answers before its routes.
  const web = HttpRouter.toWebHandler(app, { disableLogger: true })

  yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({ port, hostname: "127.0.0.1", fetch: (request) => web.handler(request) }),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  )

  return yield* Effect.never
})

program.pipe(Effect.scoped, BunRuntime.runMain)
