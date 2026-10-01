/**
 * One orders runner for the crash drill: the whole app on HTTP, with its
 * executor calling the drill's payment provider over HTTP. `DRILL_FAULT`
 * names one fault point and the command or effect it waits for; the first
 * time the runner reaches it, it prints `FAULT` and stops there until the
 * drill kills the process.
 */
import { BunCrypto, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Actors, Database } from "@durable-actors/core/runtime"
import { TurnHooks } from "@durable-actors/core/testing"
import { Config, Console, Effect, Layer, Redacted } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/http"
import { OrdersLive } from "../layer.ts"
import { Payments } from "../payments/client.ts"
import { routes } from "../server.ts"

/**
 * The runner's runtime, with short leases and backoff so a dead runner's claims
 * pass to the next one within seconds.
 */
const runtime = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Config.String("DRILL_DATABASE_URL")
    const provider = yield* Config.String("DRILL_PROVIDER_URL")
    const fault = yield* Config.String("DRILL_FAULT")
    let reached = false

    const hooks = Layer.succeed(TurnHooks, {
      at: (point, request) =>
        !reached && `${point}:${request.command}` === fault
          ? Effect.suspend(() => {
              reached = true

              return Console.log(`FAULT ${fault}`).pipe(Effect.andThen(Effect.never))
            })
          : Effect.void,
    })

    return OrdersLive.pipe(
      Layer.provide(Payments.http(provider).pipe(Layer.provide(FetchHttpClient.layer))),
      Layer.provideMerge(
        Actors.layer({
          relay: { poll: "100 millis", claimLease: "3 seconds", maxBackoff: "1 second" },
          executors: { lease: "3 seconds" },
        }).pipe(Layer.provide(hooks)),
      ),
      Layer.provideMerge(Database.postgres({ url: Redacted.make(database) })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer))

const server = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Int("DRILL_PORT")

    return HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provide(BunHttpServer.layer({ port })),
    )
  }),
)

/**
 * `LISTENING` and `FAULT` are tagged so the drill can tell them from runtime
 * logs that share stdout.
 */
server.pipe(
  Layer.provide(runtime),
  Layer.build,
  Effect.andThen(Console.log("LISTENING")),
  Effect.andThen(Effect.never),
  Effect.scoped,
  BunRuntime.runMain,
)
