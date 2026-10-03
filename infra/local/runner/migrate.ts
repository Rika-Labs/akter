import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Actors, checkWorkflows, Database, formatIncompatibility } from "@rikalabs/akter/runtime"
import { Config, Effect, Layer } from "effect"
import { Counter } from "./counter.ts"
import { peerRunner } from "./peer.ts"

/**
 * The one-shot migration a release runs before its runners start: building
 * `Actors.layer` with the same socket runner wiring as the served runner, so a database
 * the served runners configured accepts it, creates and migrates the framework tables, then the public
 * workflow check refuses a release whose workflows strand an open execution.
 * The process exits 0 when both pass and nonzero otherwise, and holds no
 * connection afterwards.
 */
const live = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* Config.Redacted("DATABASE_URL")

    return Layer.provideMerge(
      Actors.layer().pipe(Layer.provide(peerRunner)),
      Database.postgres({ url }),
    ).pipe(Layer.provideMerge(BunCrypto.layer))
  }),
)

const program = Effect.gen(function* () {
  const runtime = yield* Layer.build(live)

  const incompatibilities = yield* checkWorkflows([Counter]).pipe(Effect.provideContext(runtime))

  if (incompatibilities.length === 0) return yield* Effect.logInfo("migrated")

  return yield* Effect.die(new Error(incompatibilities.map(formatIncompatibility).join("\n")))
}).pipe(Effect.scoped)

BunRuntime.runMain(program)
