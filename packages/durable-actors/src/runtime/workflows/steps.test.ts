import { Effect, type Option, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { Actor } from "../../index.ts"

class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", { sku: Schema.String }) {}

class Paid extends Actor.Event<Paid>()("Paid", { amount: Schema.Int }) {}

describe("workflow step constructors", () => {
  it("types Ship.step results and errors at the call site", () => {
    const Ship = Actor.workflow("Ship", { input: { sku: Schema.String }, output: Schema.String })

    const Reserve = Ship.step("reserve", {
      input: Schema.String,
      success: Schema.Int,
      errors: [OutOfStock],
    })

    const AwaitPaid = Ship.wait("paid", Paid)
    const Pick = Ship.race("pick", { success: Schema.String })
    const run = Reserve.run("a", () => Effect.succeed(1))

    expectTypeOf<Effect.Success<typeof run>>().toEqualTypeOf<number>()
    expectTypeOf<Effect.Error<typeof run>>().toEqualTypeOf<OutOfStock>()
    expectTypeOf<Parameters<typeof Reserve.run>[0]>().toEqualTypeOf<string>()
    expectTypeOf<Effect.Success<ReturnType<typeof AwaitPaid>>>().toEqualTypeOf<
      Option.Option<Paid>
    >()
    expectTypeOf<Effect.Success<ReturnType<typeof Pick.run>>>().toEqualTypeOf<string>()
    expect(Reserve.kind).toBe("activity")
  })

  it("throws on two constructors with one name, of any kind", () => {
    const Ship = Actor.workflow("Ship", { output: Schema.String })
    Ship.step("reserve")

    expect(() => Ship.step("reserve")).toThrow("already has a step named reserve")
    expect(() => Ship.sleep("reserve")).toThrow("already has a step named reserve")
    expect(() => Ship.wait("reserve", Paid)).toThrow("already has a step named reserve")
    expect(() => Ship.race("reserve", { success: Schema.String })).toThrow(
      "already has a step named reserve",
    )
  })
})
