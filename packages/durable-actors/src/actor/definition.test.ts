import { Effect, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { Actor, ActorError, Actors, Commands, Lifecycle, Mailbox, State } from "../index.ts"

describe("actor declarations", () => {
  it("narrows identity, internal methods and creation error reasons", () => {
    const Create = Actor.command("Create")
    const Read = Actor.command("Read")
    const Internal = Actor.command("Internal")

    const A = Actor.make("A", {
      commands: [Create, Read],
      internal: [Internal],
      lifecycle: [Lifecycle.createdBy(Create)],
    })

    const B = Actor.make("B", { commands: [Read] })
    const Bounded = Actor.make("Bounded", { commands: [Read], lifecycle: [Mailbox.capacity(2)] })
    const Named = Actor.make("Named", { id: Schema.NonEmptyString, commands: [Read] })
    const Singleton = Actor.make("Singleton", { singleton: true, commands: [Read] })

    type Public = Effect.Success<ReturnType<typeof A.get>>

    type FrameworkReason<F extends (...args: never[]) => Effect.Effect<unknown, unknown>> = Extract<
      Effect.Error<ReturnType<F>>,
      ActorError
    >["reason"]["_tag"]

    expectTypeOf<keyof Public>().toEqualTypeOf<"ref" | "Create" | "Read">()
    expectTypeOf<keyof Actors["Service"]>().toEqualTypeOf<"mintActorId" | "mintCommandId">()
    expect(Object.getOwnPropertySymbols(A)).toEqual([])
    expectTypeOf<Extract<FrameworkReason<Public["Create"]>, "NotCreated">>().toEqualTypeOf<never>()
    expectTypeOf<
      Extract<FrameworkReason<Public["Read"]>, "NotCreated">
    >().toEqualTypeOf<"NotCreated">()
    expectTypeOf<
      Extract<
        FrameworkReason<Effect.Success<ReturnType<typeof B.get>>["Read"]>,
        "NotCreated" | "InvalidInput" | "TransportError" | "MailboxFull"
      >
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Extract<
        FrameworkReason<Effect.Success<ReturnType<typeof Bounded.get>>["Read"]>,
        "MailboxFull"
      >
    >().toEqualTypeOf<"MailboxFull">()
    expectTypeOf<ActorError.Of<never>>().toEqualTypeOf<never>()
    expectTypeOf<typeof A.id.Type>().not.toEqualTypeOf<typeof B.id.Type>()
    expectTypeOf<Parameters<typeof A.get>[0]>().toEqualTypeOf<typeof A.id.Type>()
    expectTypeOf<Parameters<typeof Named.get>[0]>().toEqualTypeOf<string>()
    expectTypeOf<typeof Named.create>().toEqualTypeOf<never>()
    expectTypeOf<typeof Singleton.create>().toEqualTypeOf<never>()
    expectTypeOf<Effect.Success<ReturnType<typeof Actors.mint<typeof A>>>>().toEqualTypeOf<
      typeof A.id.Type
    >()
    // @ts-expect-error named actor identities cannot be minted
    const _namedMint = Actors.mint(Named)
    // @ts-expect-error singleton identities cannot be minted
    const _singletonMint = Actors.mint(Singleton)
    expectTypeOf<Parameters<typeof Singleton.get>>().toEqualTypeOf<
      [options?: import("./definition.ts").GetOptions]
    >()
    expect(() => A.id.make("not-a-uuid")).toThrow()
    expect(() =>
      Actor.make("Invalid", { commands: [Read], singleton: true, id: Schema.String }),
    ).toThrow("Singleton")
  })
  it("rejects invalid and duplicate policies and foreign creation commands", () => {
    const Create = Actor.command("Create")
    expect(() => Commands.timeout(0)).toThrow()
    expect(() => State.maxBytes(1.5)).toThrow()
    expect(() =>
      Actor.make("Invalid", {
        commands: [Create],
        lifecycle: [State.maxBytes(12), State.maxBytes(13)],
      }),
    ).toThrow("Duplicate policy")
    expect(() =>
      Actor.make("Invalid", { commands: [], lifecycle: [Lifecycle.createdBy(Create)] }),
    ).toThrow("belong")
  })
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
