import { BunCrypto, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import {
  Actors,
  Auth,
  AssertionKeySet,
  Database,
  Inspector,
  RuntimeControl,
  type AuthProvider,
} from "@rikalabs/akter/runtime"
import { Cause, Config, Context, Exit, Duration, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpRouter } from "effect/http"
import { Counter, counterLayers } from "./counter.ts"
import { Ledger, ledgerLayers } from "./ledger.ts"
import { peerRunner } from "./peer.ts"

const decodeKeys = Schema.decodeUnknownEffect(Schema.fromJsonString(AssertionKeySet))

/**
 * The runner's configuration from its environment.
 *
 * It trusts exactly the edge named by `ASSERTION_ISSUER`, for the deployment
 * `ASSERTION_AUDIENCE` in `ASSERTION_REGION`, and verifies assertions against
 * either the key set at `ASSERTION_KEYS_URL` or the static `ASSERTION_KEYS`
 * JSON (`{ "keys": [{ "kid", "kty": "OKP", "crv": "Ed25519", "x" }] }`). The
 * database URL stays redacted and no credential is read from anywhere else.
 */
const load = Effect.gen(function* () {
  const url = yield* Config.option(Config.String("ASSERTION_KEYS_URL"))
  const inline = yield* Config.option(Config.String("ASSERTION_KEYS"))

  if (Option.isNone(url) === Option.isNone(inline))
    return yield* Effect.die(new Error("set exactly one of ASSERTION_KEYS_URL and ASSERTION_KEYS"))

  const options = {
    issuer: yield* Config.String("ASSERTION_ISSUER"),
    audience: yield* Config.String("ASSERTION_AUDIENCE"),
    region: yield* Config.String("ASSERTION_REGION").pipe(
      Config.orElse(() => Config.String("RUNNER_REGION")),
    ),
    refreshEvery: yield* Config.Duration("ASSERTION_REFRESH_EVERY").pipe(
      Config.withDefault(Duration.seconds(30)),
    ),
  }

  const auth: AuthProvider<HttpClient.HttpClient> = Option.isSome(url)
    ? Auth.assertion({ ...options, keys: new URL(url.value) })
    : Auth.assertion({ ...options, keys: yield* decodeKeys(Option.getOrThrow(inline)) })

  const basePath = yield* Config.String("BASE_PATH").pipe(Config.withDefault(""))

  return {
    auth,
    basePath: basePath === "" ? undefined : (basePath as `/${string}`),
    database: yield* Config.Redacted("DATABASE_URL"),
    hostname: yield* Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
    port: yield* Config.Port("PORT").pipe(Config.withDefault(8080)),
    version: yield* Config.String("RUNNER_VERSION").pipe(Config.withDefault("dev")),
    runner: yield* Config.String("HOSTNAME").pipe(Config.withDefault("local")),
    drainDeadline: yield* Config.Duration("DRAIN_DEADLINE").pipe(
      Config.withDefault(Duration.seconds(20)),
    ),
  }
})

/**
 * A locally built example runner: a served `Counter` and `Ledger` over
 * Postgres behind the edge's assertions. It is a public socket runner, so a replacement
 * release can start while the one it replaces still serves.
 *
 * SIGTERM interrupts the program, whose last finalizer to register runs
 * first: `RuntimeControl.drain` makes the runner unready and lets in-flight
 * turns finish while the server still answers, and only then do the server
 * and the runtime layer close, which hands the shards over and ends the
 * process.
 */
const program = Effect.gen(function* () {
  const config = yield* load

  const runtime = yield* Layer.build(
    Layer.mergeAll(
      ...counterLayers({ version: config.version, runner: config.runner }),
      ...ledgerLayers,
    ).pipe(
      Layer.provideMerge(Actors.layer().pipe(Layer.provide(peerRunner))),
      Layer.provideMerge(Database.postgres({ url: config.database })),
      Layer.provideMerge(BunCrypto.layer),
    ),
  )

  yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        Actors.serve({
          actors: [Counter, Ledger],
          auth: config.auth,
          basePath: config.basePath,
        }),
        Inspector.serve({ auth: config.auth }),
      ),
    ).pipe(
      Layer.provide(Layer.succeedContext(runtime)),
      Layer.provide(BunHttpServer.layer({ hostname: config.hostname, port: config.port })),
      Layer.provide(FetchHttpClient.layer),
    ),
  )

  const control = Context.get(runtime, RuntimeControl)

  yield* Effect.addFinalizer(() =>
    control
      .drain({ deadline: config.drainDeadline })
      .pipe(
        Effect.flatMap((report) =>
          Effect.logInfo(
            `drain ${report.outcome} interruptedTurns=${report.interruptedTurns} interruptedJobs=${report.interruptedJobs}`,
          ),
        ),
      ),
  )

  yield* Effect.logInfo(`serving ${config.version} on ${config.hostname}:${config.port}`)

  return yield* Effect.never
}).pipe(Effect.scoped)

BunRuntime.runMain(program, {
  teardown: (exit, onExit) =>
    onExit(Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) ? 0 : 1),
})
