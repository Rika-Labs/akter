import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { CommandId, commandTimes } from "./command.ts"
import { connectionCommandId } from "./connection.ts"

describe("connection command ids", () => {
  const commands = { secret: "ab".repeat(32), seq: 3, issuedAt: 1000, expiresAt: 6000 }

  it("are stable for one call and distinct across seq, index, target, command, and secret", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const id = (overrides: Partial<typeof commands>, index = 0, target = "t", command = "C") =>
          connectionCommandId({ commands: { ...commands, ...overrides }, index, target, command })

        const first = yield* id({})
        expect(yield* id({})).toBe(first)
        expect(Schema.is(CommandId)(first)).toBe(true)
        expect(commandTimes(first)).toEqual({ issuedAt: 1000, expiresAt: 6000 })

        const others = [
          yield* id({ seq: 4 }),
          yield* id({}, 1),
          yield* id({}, 0, "u"),
          yield* id({}, 0, "t", "D"),
          yield* id({ secret: "cd".repeat(32) }),
        ]

        expect(new Set([first, ...others]).size).toBe(6)
      }),
    ))
})
