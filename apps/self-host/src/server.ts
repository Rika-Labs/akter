import { timingSafeEqual } from "node:crypto"
import { readFileSync } from "node:fs"
import { Actor, ActorError, isUser, Unauthorized, User } from "@rikalabs/akter"
import { Akter, App, Auth, RuntimeControl, Store } from "@rikalabs/akter/server"
import type { AuthRequest, RunnerOptions } from "@rikalabs/akter/server"
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect"

/** The recipe's actor: a counter every authenticated caller can add to and watch. */
const Counter = Actor.make("Counter", {
  state: Schema.Struct({
    count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  actions: { add: Actor.action(Schema.Finite, { success: Schema.Finite }) },
  views: { count: Actor.view(Schema.Finite) },
  access: isUser,
})

const CounterLive = Counter.toLayer({
  add: (counter, amount) => {
    counter.count += amount
    return counter.count
  },
  count: (counter) => counter.count,
})

/** A mounted secret file, trimmed; never logged. */
const secret = (name: string) => readFileSync(`/run/secrets/${name}`, "utf8").trim()

const refused = (code: "missing_credentials" | "invalid_credentials") =>
  ActorError.make({ reason: Unauthorized.make({ code }) })

/**
 * One bearer token, mounted as the `api-token` secret, authenticates as `self-host-client` in the
 * `default` tenant. Replace it with the application's own provider before exposing an ingress.
 */
const bearer = () => {
  const token = Buffer.from(secret("api-token"))
  return Auth.make((request: AuthRequest) =>
    Effect.gen(function* () {
      const header = request.credential ?? request.headers["authorization"]
      if (header === undefined || !header.startsWith("Bearer "))
        return yield* refused("missing_credentials")
      const given = Buffer.from(header.slice("Bearer ".length))
      if (given.length !== token.length || !timingSafeEqual(given, token))
        return yield* refused("invalid_credentials")
      return { caller: User.make({ subject: "self-host-client" }), tenant: "default" }
    }),
  )
}

/**
 * `S3_BUCKET` selects an S3-compatible bucket (with `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`
 * and the `s3-secret-access-key` secret); without it the store is a directory, `STORE_DIRECTORY`.
 */
const store = Layer.unwrap(
  Effect.gen(function* () {
    const bucket = yield* Config.option(Config.String("S3_BUCKET"))
    if (Option.isNone(bucket))
      return Store.fileSystem(
        yield* Config.String("STORE_DIRECTORY").pipe(Config.withDefault("/data/store")),
      )
    return Store.s3({
      bucket: bucket.value,
      endpoint: Option.getOrUndefined(yield* Config.option(Config.String("S3_ENDPOINT"))),
      region: yield* Config.String("S3_REGION").pipe(Config.withDefault("us-east-1")),
      credentials: {
        accessKeyId: yield* Config.String("S3_ACCESS_KEY_ID"),
        secretAccessKey: secret("s3-secret-access-key"),
      },
    })
  }),
)

const serving = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* Config.option(Config.String("RUNNER_HOST"))
    let runner: RunnerOptions | undefined
    if (Option.isSome(host)) {
      const port = yield* Config.Int("RUNNER_PORT")
      runner = {
        address: { host: host.value, port },
        listenAddress: { host: "0.0.0.0", port },
        peering: {
          deployment: yield* Config.String("PEER_IDENTITY"),
          credentials: Effect.sync(() => ({
            ca: secret("peer-ca"),
            certificate: secret("peer-certificate"),
            key: Redacted.make(secret("peer-key")),
          })),
        },
      }
    }
    return Akter.serve({
      app: App.make({ actors: [Counter], layer: CounterLive }),
      auth: bearer(),
      runner,
    })
  }),
).pipe(Layer.provide(store))

const main = Effect.scoped(
  Effect.gen(function* () {
    const context = yield* Layer.build(serving)
    yield* RuntimeControl.waitForSignal({ deadline: "15 seconds" }).pipe(
      Effect.provideContext(context),
    )
  }),
)

if (typeof Bun === "undefined") {
  const { NodeServices } = await import("@effect/platform-node")
  await Effect.runPromise(Effect.provide(main, NodeServices.layer))
} else {
  const { BunServices } = await import("@effect/platform-bun")
  await Effect.runPromise(Effect.provide(main, BunServices.layer))
}
