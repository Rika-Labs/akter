import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Actor } from "../index.ts"

describe("actor declarations", () => {
  it("rejects duplicate commands and state capability collisions", () => {
    const Increment = Actor.command("Increment", { input: Schema.Finite, output: Schema.Finite })
    expect(() => Actor.make("Counter", { commands: [Increment, Increment], state: {} })).toThrow(
      "Duplicate",
    )
    expect(() =>
      Actor.make("Counter", { commands: [Increment], state: { set: Schema.Finite } }),
    ).toThrow("reserved")
  })
  it("preserves declaration types and decoding defaults", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const Increment = Actor.command("Increment", {
          input: Schema.Finite,
          output: Schema.Finite,
        })

        const Counter = Actor.make("Counter", {
          commands: [Increment],
          state: { count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(7))) },
        })

        expect(yield* Schema.decodeEffect(Counter.state)({})).toEqual({ count: 7 })
        Counter.toLayer({ Increment: (ctx, amount) => Effect.succeed(ctx.state.count + amount) })
      }),
    ))
})
