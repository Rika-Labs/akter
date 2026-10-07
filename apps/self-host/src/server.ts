import { User, Unauthorized } from "@rikalabs/akter"
import { Actors, Auth, Database, Runner, RuntimeControl } from "@rikalabs/akter/runtime"
import { Config, Console, Effect, Fiber, FileSystem, Layer, Option, Redacted, Schema } from "effect"
import { Headers, HttpRouter, HttpServerResponse } from "effect/http"
import { Counter } from "./contract.ts"
import { CounterLive } from "./layer.ts"

class ConfigurationError extends Schema.TaggedError<ConfigurationError>()("ConfigurationError", {
  message: Schema.String,
}) {}

const runtime = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* Config.String("RUNNER_HOST")
    const databaseHost = yield* Config.String("DATABASE_HOST").pipe(Config.withDefault("postgres"))
    const fs = yield* FileSystem.FileSystem
    const password = (yield* fs.readFileString("/run/secrets/database-password")).trim()
    const token = Redacted.make((yield* fs.readFileString("/run/secrets/api-token")).trim())
    if (password.length === 0 || Redacted.value(token).length < 32)
      return yield* ConfigurationError.make({
        message: "Set a database password and an API token of at least 32 characters",
      })

    const transport = Runner.socket({
      address: { host, port: 9000 },
      listenAddress: { host: "0.0.0.0", port: 9000 },
      transport: Runner.mtls({
        deployment: "self-host",
        credentials: Effect.all({
          ca: fs.readFileString("/run/secrets/ca.pem"),
          certificate: fs.readFileString("/run/secrets/certificate.pem"),
          key: fs.readFileString("/run/secrets/key.pem").pipe(Effect.map(Redacted.make)),
        }),
      }),
    })
    const auth = Auth.make((request) =>
      Option.getOrElse(Headers.get(request.headers, "authorization"), () => "") ===
      `Bearer ${Redacted.value(token)}`
        ? Effect.succeed({ tenant: "default", caller: User.make({ subject: "self-host-client" }) })
        : Effect.fail(Unauthorized.make({ code: "invalid_credentials" })),
    )
    const health = HttpRouter.add("GET", "/health", HttpServerResponse.text("alive"))
    const live = CounterLive.pipe(
      Layer.provideMerge(Actors.layer().pipe(Layer.provide(transport))),
      Layer.provideMerge(
        Database.postgres({
          url: Redacted.make(
            `postgres://project:${encodeURIComponent(password)}@${databaseHost}:5432/project`,
          ),
          maxConnections: 10,
          offTurnConnections: 5,
          queryConnections: 5,
        }),
      ),
    )
    return HttpRouter.serve(Layer.merge(health, Actors.serve({ actors: [Counter], auth })), {
      disableListenLog: true,
    }).pipe(Layer.provideMerge(live))
  }),
)

/** The signal completes normally so drain runs while the HTTP and actor layers remain alive. */
const termination = Effect.callback<void>((resume) => {
  const stop = () => resume(Effect.void)
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  return Effect.sync(() => {
    process.removeListener("SIGTERM", stop)
    process.removeListener("SIGINT", stop)
  })
})

export const server = Effect.gen(function* () {
  const signal = yield* termination.pipe(Effect.forkScoped)
  const context = yield* Layer.build(runtime)
  yield* Effect.gen(function* () {
    const control = yield* RuntimeControl
    yield* Fiber.join(signal)
    const report = yield* control.drain({ deadline: "15 seconds" })
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(report)
    yield* Console.log(`DRAINED ${json}`)
  }).pipe(Effect.provide(context))
}).pipe(Effect.scoped)
