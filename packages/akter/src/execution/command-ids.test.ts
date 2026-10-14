import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"
import { CommandIds } from "./command-ids.ts"

describe("client id issuance", () => {
  it("rejects interpolating fractional clock milliseconds into the dot-delimited wire id", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const now of [12_575.773263, 12_576]) {
          const id = yield* CommandIds.mint(now)
          const parsed = Result.getOrThrow(CommandIds.parse(id, now))
          expect(parsed.issuedAt).toBe(Math.floor(now))
          expect(parsed.expiresAt).toBe(Math.floor(now) + 600_000)
        }
      }),
    ))
})
