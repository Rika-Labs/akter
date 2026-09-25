import { BunCrypto } from "@effect/platform-bun"
import { Cause, Effect, Exit, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { ActorTest } from "./actor-test.ts"

describe("ActorTest.cluster", () => {
  it("refuses PGlite, whose single connection cannot host several runners", async () => {
    for (const database of [undefined, { dataDir: "memory://" }]) {
      const exit = await Effect.runPromiseExit(
        Layer.build(
          ActorTest.cluster({
            database,
            runners: 2,
            shardLockExpiration: "5 seconds",
            actors: Layer.empty,
          }),
        ).pipe(Effect.scoped, Effect.provide(BunCrypto.layer)),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain(
        "ActorTest.cluster needs a Postgres database URL",
      )
    }
  })
})
