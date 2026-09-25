import { type Context, Effect, Layer, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { Actor, ActorError, type Actors } from "../index.ts"
import type { InternalActors } from "../handles/actors.ts"
import { routingKey } from "../runtime/storage/codec.ts"

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
    expectTypeOf<
      Extract<FrameworkReason<Public["Read"]>, "RunnerAtCapacity">
    >().toEqualTypeOf<"RunnerAtCapacity">()
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
      Actor.make("Reserved", { api: { Increment }, state: Actor.state({ set: Schema.Finite }) }),
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

  it("places by tenant by default and by actor on request", () => {
    const Read = Actor.command("Read")
    const ref = { tenant: "t", actor: "Session", id: "a" }
    const other = { ...ref, id: "b" }
    expect(Actor.make("Session", { api: { Read }, placement: "actor" })).toBeDefined()
    expect(routingKey({ ref, placement: "tenant" })).toBe(
      routingKey({ ref: other, placement: "tenant" }),
    )
    expect(routingKey({ ref, placement: "actor" })).not.toBe(
      routingKey({ ref: other, placement: "actor" }),
    )
    expect(routingKey({ ref: { ...ref, tenant: "u" }, placement: "tenant" })).not.toBe(
      routingKey({ ref, placement: "tenant" }),
    )
    // @ts-expect-error placement is "tenant" or "actor"
    const _invalid = Actor.make("Bad", { api: { Read }, placement: "region" })
  })

  it("splits commands and queries between toLayer and toQueryLayer", () => {
    const Bump = Actor.command("Bump")
    const Peek = Actor.query("Peek", { output: Schema.Finite })

    const Box = Actor.make("Box", {
      state: Actor.state({ n: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
      api: { Bump, Peek },
    })

    type Public = Effect.Success<ReturnType<typeof Box.create>>

    type Reason<F extends (...args: never[]) => Effect.Effect<unknown, unknown>> = Extract<
      Effect.Error<ReturnType<F>>,
      ActorError
    >["reason"]["_tag"]

    expectTypeOf<Reason<Public["Peek"]>>().toEqualTypeOf<"ActorUnavailable" | "Unauthorized">()

    const commands = Box.toLayer(Effect.succeed({ Bump: () => Effect.void }))
    expectTypeOf(commands).toEqualTypeOf<Layer.Layer<never, never, InternalActors>>()
    expectTypeOf<
      keyof Effect.Success<Parameters<typeof Box.toLayer<never, never>>[0]>
    >().toEqualTypeOf<"Bump">()
    expectTypeOf<
      keyof Effect.Success<Parameters<typeof Box.toQueryLayer<never, never>>[0]>
    >().toEqualTypeOf<"Peek">()

    const reads = Box.toQueryLayer(
      Effect.succeed({
        Peek: Effect.fnUntraced(function* () {
          return (yield* Box.Read).state.n
        }),
      }),
    )

    expectTypeOf(reads).toEqualTypeOf<Layer.Layer<never, never, InternalActors>>()

    const writesInQuery = Box.toQueryLayer(
      Effect.succeed({
        Peek: Effect.fnUntraced(function* () {
          yield* Box.Turn

          return 1
        }),
      }),
    )

    expectTypeOf(writesInQuery).not.toEqualTypeOf<Layer.Layer<never, never, InternalActors>>()

    const Other = Actor.make("Other", { api: { Peek } })

    const readsOther = Box.toQueryLayer(
      Effect.succeed({
        Peek: Effect.fnUntraced(function* () {
          yield* Other.Read

          return 1
        }),
      }),
    )

    expectTypeOf(readsOther).toEqualTypeOf<
      Layer.Layer<never, never, Context.Service.Identifier<typeof Other.Read> | InternalActors>
    >()
    // @ts-expect-error internal members must be commands
    expect(() => Actor.make("Hidden", { api: { Bump }, internal: { Peek } })).toThrow("commands")
  })

  it("rejects invalid state migration chains", () => {
    const Noop = Actor.command("Noop")
    const V0 = { a: Schema.String }
    const V1 = { b: Schema.String }
    const V2 = { c: Schema.String }

    expect(() =>
      Actor.make("Gap", {
        state: Actor.state(V2, {
          migrations: [
            Actor.migration(V0, V1, ({ a }) => ({ b: a })),
            Actor.migration(V0, V2, ({ a }) => ({ c: a })),
          ],
        }),
        api: { Noop },
      }),
    ).toThrow("previous migration")
    expect(() =>
      Actor.make("Stale", {
        state: Actor.state(V2, { migrations: [Actor.migration(V0, V1, ({ a }) => ({ b: a }))] }),
        api: { Noop },
      }),
    ).toThrow("declared state")
    expect(() =>
      Actor.make("Reserved", { state: Actor.state({ $version: Schema.Finite }), api: { Noop } }),
    ).toThrow("reserved")
    // @ts-expect-error an upcast must produce the next shape
    Actor.migration(V0, V1, ({ a }) => ({ c: a }))
  })

  it("types handler requirements through the per-actor Turn service", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const Increment = Actor.command("Increment", {
          input: Schema.Finite,
          output: Schema.Finite,
        })

        const Counter = Actor.make("Counter", {
          state: Actor.state({
            count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(7))),
          }),
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
