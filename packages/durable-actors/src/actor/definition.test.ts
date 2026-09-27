import { type Context, Effect, Layer, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import {
  Actor,
  ActorError,
  type Actors,
  Intent,
  type EventEntry,
  type QueryContext,
  type RetentionGap,
  type UnknownCursor,
} from "../index.ts"
import type { InternalActors } from "../handles/actors.ts"
import type { BlobRead, BlobWrite } from "../state/blob.ts"
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

    expectTypeOf<Reason<Public["Peek"]>>().toEqualTypeOf<
      "ActorUnavailable" | "Unauthorized" | "Timeout"
    >()

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

  it("types turn.emit and read.events to the declared events of X.Turn and X.Read", () => {
    class Posted extends Actor.Event<Posted>()("Posted", { body: Schema.String }) {}

    class Undeclared extends Actor.Event<Undeclared>()("Undeclared", {}) {}

    const Post = Actor.command("Post")
    const History = Actor.query("History", { output: Schema.Array(Schema.String) })
    const Feed = Actor.make("Feed", { events: [Posted], api: { Post, History } })
    const Plain = Actor.make("Plain", { api: { Post } })

    expect(() => Actor.make("Twice", { events: [Posted, Posted], api: { Post } })).toThrow(
      "Duplicate event",
    )

    const emits = Effect.gen(function* () {
      const turn = yield* Feed.Turn
      yield* turn.emit(Posted.make({ body: "hi" }))
      // @ts-expect-error only declared event classes can be emitted
      yield* turn.emit(Undeclared.make({}))
    })

    // Emitting needs X.Turn, which only a command turn provides.
    expectTypeOf<Effect.Services<typeof emits>>().toEqualTypeOf<
      Context.Service.Identifier<typeof Feed.Turn>
    >()
    // @ts-expect-error an effect that emits cannot run outside a turn
    const _outside = () => Effect.runPromise(emits)

    const plain = Effect.gen(function* () {
      const turn = yield* Plain.Turn
      // @ts-expect-error an actor without events cannot emit
      yield* turn.emit(Posted.make({ body: "hi" }))
    })

    expect(plain).toBeDefined()

    const reads = Feed.toQueryLayer(
      Effect.succeed({
        History: Effect.fnUntraced(function* () {
          const read = yield* Feed.Read
          const entries = yield* read.events(Posted, { after: "0" }).pipe(Effect.orDie)
          expectTypeOf(entries).toEqualTypeOf<ReadonlyArray<EventEntry<Posted>>>()

          return entries.map(({ event }) => event.body)
        }),
      }),
    )

    expectTypeOf(reads).toEqualTypeOf<Layer.Layer<never, never, InternalActors>>()

    const replay = Effect.gen(function* () {
      return yield* (yield* Feed.Read).events(Posted)
    })

    expectTypeOf<Effect.Error<typeof replay>>().toEqualTypeOf<UnknownCursor | RetentionGap>()

    const misuse = (read: QueryContext<{}, typeof Posted>) => [
      // @ts-expect-error queries are read-only and cannot emit
      read.emit,
      // @ts-expect-error only declared event classes can be replayed
      read.events(Undeclared),
    ]

    expect(misuse).toBeDefined()
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

  it("offers intents only inside command turns and keeps request/reply out of them", () => {
    const Ping = Actor.command("Ping", { input: Schema.String })
    const Wake = Actor.command("Wake")
    const Peek = Actor.query("Peek", { output: Schema.Finite })

    const Target = Actor.make("Target", {
      key: Schema.String,
      api: { Ping, Peek },
      internal: { Wake },
    })

    const Lone = Actor.make("Lone", { key: Actor.singleton, api: { Ping } })

    type TargetIntents = Effect.Success<ReturnType<typeof Target.intents>>

    expectTypeOf<keyof TargetIntents>().toEqualTypeOf<"ref" | "Ping" | "Wake">()
    expectTypeOf<Parameters<typeof Lone.intents>>().toEqualTypeOf<[]>()
    expectTypeOf<Effect.Services<ReturnType<typeof Target.intents>>>().toEqualTypeOf<
      Context.Service.Identifier<typeof Actor.InTurn>
    >()

    const sends = Target.toLayer(
      Effect.succeed({
        Ping: Effect.fnUntraced(function* () {
          const later = yield* Target.intents("other")
          yield* later.Wake().pipe(Intent.after("1 hour"), Intent.key("wake"))
          yield* later.Ping("hi")
          yield* Intent.cancel("wake")
        }),
        Wake: () => Effect.void,
      }),
    )

    expectTypeOf(sends).toEqualTypeOf<Layer.Layer<never, never, InternalActors>>()

    const intentsInQuery = Target.toQueryLayer(
      Effect.succeed({
        Peek: Effect.fnUntraced(function* () {
          yield* Target.intents("other")

          return 1
        }),
      }),
    )

    expectTypeOf(intentsInQuery).toEqualTypeOf<
      Layer.Layer<never, never, Context.Service.Identifier<typeof Actor.InTurn> | InternalActors>
    >()

    // Outside a turn nothing provides InTurn, so neither Effect can run.
    expectTypeOf(Target.intents("other")).not.toExtend<Effect.Effect<unknown>>()
    expectTypeOf(Intent.cancel("wake")).not.toExtend<Effect.Effect<unknown>>()

    const _requestReply = Target.toLayer(
      // @ts-expect-error a handle acquired inside a turn could only make a request/reply call
      Effect.succeed({
        Ping: Effect.fnUntraced(function* () {
          const target = yield* Target.get("other")
          yield* target.Ping("hi").pipe(Effect.orDie)
        }),
        Wake: () => Effect.void,
      }),
    )

    expect(() => Intent.after(-1)).toThrow("non-negative")
    expect(() => Intent.key("")).toThrow("1-200")
  })
  it("types effects, executors, and routes against the executor's return type", () => {
    class Moderate extends Actor.effect<Moderate>()("Moderate", {
      input: { body: Schema.String },
      success: Schema.Struct({ flagged: Schema.Boolean }),
    }) {}

    class Other extends Actor.effect<Other>()("Other") {}

    const Post = Actor.command("Post")

    const Moderated = Actor.command("Moderated", {
      input: Schema.Struct({ flagged: Schema.Boolean }),
    })

    const Failed = Actor.command("Failed", { input: Actor.DeadLetter(Moderate) })

    const Wrong = Actor.command("Wrong", { input: Schema.String })

    const Room = Actor.make("EffectTypes", {
      effects: [Moderate],
      api: { Post },
      internal: { Moderated, Failed },
      policy: {
        effects: { Moderate: { retry: { times: 2 }, onSuccess: Moderated, onDeadLetter: Failed } },
      },
    })

    expect(Moderate.tag).toBe("Moderate")
    expect(Moderate.make({ body: "hi" })).toBeInstanceOf(Moderate)

    type Executor = (typeof Room.Executor)["Service"]

    type Read = (typeof Room.Read)["Service"]

    expectTypeOf<Executor["effectId"]>().toEqualTypeOf<string>()
    expectTypeOf<Executor["attempt"]>().toEqualTypeOf<number>()
    expectTypeOf<keyof Read>().not.toEqualTypeOf<keyof Read | "perform">()
    expectTypeOf(Actor.effect()("NoSelf")).toBeString()

    Actor.make("WrongSuccess", {
      effects: [Moderate],
      api: { Wrong },
      // @ts-expect-error onSuccess must accept the executor's return type
      policy: { effects: { Moderate: { onSuccess: Wrong } } },
    })
    Actor.make("WrongDeadLetter", {
      effects: [Moderate],
      api: { Moderated },
      // @ts-expect-error onDeadLetter must accept Actor.DeadLetter(E)
      policy: { effects: { Moderate: { onDeadLetter: Moderated } } },
    })
    expect(() =>
      Actor.make("ForeignRoute", {
        effects: [Moderate],
        api: { Post },
        // @ts-expect-error a route must name a command of this actor
        policy: { effects: { Moderate: { onSuccess: Moderated } } },
      }),
    ).toThrow("routes must name a command of this actor")
    expect(() =>
      Actor.make("UndeclaredEffect", {
        effects: [Moderate],
        api: { Post },
        // @ts-expect-error policy.effects keys must be declared effects
        policy: { effects: { Other: {} } },
      }),
    ).toThrow("names no declared effect")
    expect(() =>
      Actor.make("DuplicateEffect", { effects: [Moderate, Moderate], api: { Post } }),
    ).toThrow("Duplicate effect")
    expect(() =>
      Actor.make("BadRetry", {
        effects: [Moderate],
        api: { Post },
        policy: { effects: { Moderate: { retry: { times: -1 } } } },
      }),
    ).toThrow("retry.times")

    Room.toEffectLayer(Effect.succeed({ Moderate: () => Effect.succeed({ flagged: true }) }))
    // @ts-expect-error an executor must return its effect's success type
    Room.toEffectLayer(Effect.succeed({ Moderate: () => Effect.succeed("flagged") }))

    const layer = Room.toLayer(
      Effect.succeed({
        Post: Effect.fnUntraced(function* () {
          const turn = yield* Room.Turn
          yield* turn.perform(Moderate.make({ body: "hi" }))
          // @ts-expect-error only declared effects can be performed
          yield* turn.perform(Other.make())
        }),
        Moderated: () => Effect.void,
        Failed: (letter) => Effect.log(letter.effectId, letter.effect.body, letter.ambiguous),
      }),
    )

    expectTypeOf(layer).toEqualTypeOf<Layer.Layer<never, never, InternalActors>>()
  })

  it("declares blobs, keeps queries read-only, and rejects undeclared or duplicate blobs", () => {
    const Files = Actor.blob("files")
    const Other = Actor.blob("other")
    const Put = Actor.command("Put")
    const Peek = Actor.query("Peek")
    const Box = Actor.make("BlobBox", { key: Schema.String, blobs: [Files], api: { Put, Peek } })

    type TurnOf = (typeof Box.Turn)["Service"]

    type ReadOf = (typeof Box.Read)["Service"]

    expectTypeOf<ReturnType<TurnOf["blob"]>>().toEqualTypeOf<BlobWrite>()
    expectTypeOf<ReturnType<ReadOf["blob"]>>().toEqualTypeOf<BlobRead>()
    expectTypeOf<keyof BlobRead>().toEqualTypeOf<"get">()
    expectTypeOf<Parameters<TurnOf["blob"]>[0]>().toEqualTypeOf<typeof Files>()

    const _misuse = (read: ReadOf, turn: TurnOf) => [
      // @ts-expect-error a query's blobs are read-only
      read.blob(Files).set("a", new Uint8Array()),
      // @ts-expect-error only declared blobs are reachable
      turn.blob(Other),
    ]

    expect(() => Actor.blob("has space")).toThrow("Blob name")
    expect(() =>
      Actor.make("Twice", { blobs: [Files, Actor.blob("files")], api: { Put } }),
    ).toThrow("listed twice")
    expect(() =>
      // @ts-expect-error blobs takes Actor.blob values
      Actor.make("Fake", { blobs: [{ name: "files" }], api: { Put } }),
    ).toThrow("Actor.blob")
  })
})
