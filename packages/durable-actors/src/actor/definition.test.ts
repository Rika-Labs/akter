import { Effect, Layer, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { Actor, ActorError, type Actors } from "../index.ts"
import type { InternalActors } from "../handles/actors.ts"

describe("actor declarations", () => {
  it("derives handles from api, hides internal commands, and narrows creation reasons", () => {
    const Create = Actor.command("Create")
    const Read = Actor.command("Read")
    const Internal = Actor.command("Internal")

    const A = Actor.make("A", {
      api: { Create, Read },
      internal: { Internal },
      policy: { createdBy: Create },
    })

    const B = Actor.make("B", { api: { Read } })
    const Bounded = Actor.make("Bounded", { api: { Read }, policy: { mailboxCapacity: 2 } })
    const Named = Actor.make("Named", { key: Schema.NonEmptyString, api: { Read } })
    const Singleton = Actor.make("Singleton", { key: Actor.singleton, api: { Read } })

    type Public = Effect.Success<ReturnType<typeof A.create>>

    type FrameworkReason<F extends (...args: never[]) => Effect.Effect<unknown, unknown>> = Extract<
      Effect.Error<ReturnType<F>>,
      ActorError
    >["reason"]["_tag"]

    expectTypeOf<keyof Public>().toEqualTypeOf<"ref" | "Create" | "Read">()
    expectTypeOf<keyof typeof A.api>().toEqualTypeOf<"Create" | "Read">()
    expectTypeOf<keyof Actors["Service"]>().toEqualTypeOf<"mintCommandId">()
    expect(Object.keys(A.api)).toEqual(["Create", "Read"])
    expectTypeOf<Extract<FrameworkReason<Public["Create"]>, "NotCreated">>().toEqualTypeOf<never>()
    expectTypeOf<
      Extract<FrameworkReason<Public["Read"]>, "NotCreated">
    >().toEqualTypeOf<"NotCreated">()
    expectTypeOf<
      Extract<
        FrameworkReason<Effect.Success<ReturnType<typeof B.create>>["Read"]>,
        "NotCreated" | "InvalidInput" | "TransportError" | "MailboxFull"
      >
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Extract<
        FrameworkReason<Effect.Success<ReturnType<typeof Bounded.create>>["Read"]>,
        "MailboxFull"
      >
    >().toEqualTypeOf<"MailboxFull">()
    expectTypeOf<ActorError.Of<never>>().toEqualTypeOf<never>()
    expectTypeOf<Parameters<typeof Named.get>[0]>().toEqualTypeOf<string>()
    expectTypeOf<Parameters<typeof Singleton.get>>().toEqualTypeOf<[]>()
    expectTypeOf<typeof Named.create>().toEqualTypeOf<never>()
    expectTypeOf<typeof Singleton.create>().toEqualTypeOf<never>()
    // @ts-expect-error a minted actor's id is branded, so arbitrary strings are rejected
    const _unbranded = A.get("not-a-minted-id")
  })

  it("rejects mismatched keys, duplicates, reserved names, and foreign creation commands", () => {
    const Create = Actor.command("Create")
    const Increment = Actor.command("Increment", { input: Schema.Finite, output: Schema.Finite })
    // @ts-expect-error an api key must equal its command's tag
    expect(() => Actor.make("Mismatch", { api: { Other: Increment } })).toThrow(
      "must equal its tag",
    )
    expect(() => Actor.make("Duplicate", { api: { Increment }, internal: { Increment } })).toThrow(
      "Duplicate",
    )
    expect(() =>
      Actor.make("Reserved", { api: { Increment }, state: { set: Schema.Finite } }),
    ).toThrow("reserved")
    expect(() =>
      Actor.make("Invalid", { api: { Increment }, policy: { maxStateBytes: 1.5 } }),
    ).toThrow()
    expect(() =>
      Actor.make("Invalid", { api: { Increment }, policy: { commandTimeout: 0 } }),
    ).toThrow()
    expect(() =>
      // @ts-expect-error createdBy must name a command of this actor
      Actor.make("Foreign", { api: { Increment }, policy: { createdBy: Create } }),
    ).toThrow("belong")
  })

  it("types handler requirements through the per-actor Turn service", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const Increment = Actor.command("Increment", {
          input: Schema.Finite,
          output: Schema.Finite,
        })

        const Counter = Actor.make("Counter", {
          state: { count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(7))) },
          api: { Increment },
        })

        const Other = Actor.make("Other", { api: { Increment } })

        expect(yield* Schema.decodeEffect(Counter.state)({})).toEqual({ count: 7 })

        const live = Counter.toLayer(
          Effect.succeed({
            Increment: Effect.fnUntraced(function* (amount: number) {
              return (yield* Counter.Turn).state.count + amount
            }),
          }),
        )

        expectTypeOf(live).toEqualTypeOf<Layer.Layer<never, never, InternalActors>>()

        const wrongPhase = Counter.toLayer(
          Effect.succeed({
            Increment: Effect.fnUntraced(function* (amount: number) {
              yield* Other.Turn

              return amount
            }),
          }),
        )

        expectTypeOf(wrongPhase).not.toEqualTypeOf<Layer.Layer<never, never, InternalActors>>()
      }),
    ))
})
