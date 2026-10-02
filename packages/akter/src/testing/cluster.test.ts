import { BunCrypto } from "@effect/platform-bun"
import { Cause, Effect, Exit, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { ActorTest } from "./actor-test.ts"

describe("ActorTest.cluster", () => {
  it("refuses PGlite, whose single connection cannot host several runners", () =>
    Effect.runPromise(
      Effect.forEach([undefined, { dataDir: "memory://" }], (database) =>
        Effect.gen(function* () {
          const exit = yield* Layer.build(
            ActorTest.cluster({
              database,
              runners: 2,
              shardLockExpiration: "5 seconds",
              actors: Layer.empty,
            }).pipe(Layer.provide(BunCrypto.layer)),
          ).pipe(Effect.scoped, Effect.exit)

          expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain(
            "ActorTest.cluster needs a Postgres database URL",
          )
        }),
      ),
    ))
})
