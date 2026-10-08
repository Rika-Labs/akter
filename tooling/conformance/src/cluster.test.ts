import { BunCrypto } from "@effect/platform-bun"
import { Cause, Effect, Exit, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { clusterLayer } from "./cluster.ts"

describe("clusterLayer", () => {
  it("refuses PGlite, whose single connection cannot host several runners", () =>
    Effect.runPromise(
      Effect.forEach([undefined, { dataDir: "memory://" }], (database) =>
        Effect.gen(function* () {
          const exit = yield* Layer.build(
            clusterLayer({
              database,
              runners: 2,
              shardLockExpiration: "5 seconds",
              actors: Layer.empty,
            }).pipe(Layer.provide(BunCrypto.layer)),
          ).pipe(Effect.scoped, Effect.exit)

          expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain(
            "clusterLayer needs a Postgres database URL",
          )
        }),
      ),
    ))
})
