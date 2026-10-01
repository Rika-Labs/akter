import { Context, type Duration, Effect, Layer, Result, Schema, Stream } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { pgTable, text } from "drizzle-orm/pg-core"
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
import type { ConnectOptions } from "../client/index.ts"
import type { InternalActors } from "../runtime/actors.ts"
import type { BlobRead, BlobWrite, ContentRead, ContentWrite } from "../state/blob.ts"
import { resolveSchedules } from "../policies/schedules.ts"
import { resolvePolicy } from "../policies/command.ts"
import { routingKey } from "../runtime/storage/codec.ts"

describe("actor declarations", () => {
  it("derives handles from api, hides internal commands, and narrows creation reasons", () => {
    const Create = Actor.command("Create")
    const Read = Actor.command("Read")
    const Internal = Actor.command("Internal")

    const A = Actor.make("A", {
      api: { Create, Read },
      internal: { Internal },
      createdBy: Create,
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

  it("types a client's event feed to the events the actor serves in feeds", () => {
    const Posted = Actor.event("Posted", { text: Schema.String })

    const Hidden = Actor.event("Hidden", {})

    const Ping = Actor.command("Ping")

    const Served = Actor.make("FeedTyped", {
      key: Schema.String,
      events: [Posted, Hidden],
      feeds: [Posted],
      api: { Ping },
    })

    type Events = Parameters<ReturnType<ReturnType<typeof Served.client>["get"]>["events"]>[0]

    expectTypeOf<Events>().toEqualTypeOf<typeof Posted>()
  })

  it("serves connection members on the Promise client through connect", () => {
    const Ping = Actor.command("Ping")
    const Live = Actor.connection("Live", { client: Schema.String, server: Schema.String })
    const Served = Actor.make("Served", { key: Schema.String, api: { Ping, Live } })

    type Handle = ReturnType<ReturnType<typeof Served.client>["get"]>

    expectTypeOf<keyof Handle & "Ping">().toEqualTypeOf<"Ping">()
    expectTypeOf<keyof Handle["Live"]>().toEqualTypeOf<"connect">()

    expectTypeOf<Parameters<Handle["Live"]["connect"]>>().toEqualTypeOf<
      [params?: void, options?: ConnectOptions]
    >()
    expectTypeOf<Handle["Live"]["connect"]>().parameter(0).toEqualTypeOf<void | undefined>()
    // @ts-expect-error options can't be passed where the params go
    expectTypeOf<Handle["Live"]["connect"]>().toBeCallableWith({ signal: AbortSignal.abort() })
  })

  it("types stream handles and handlers, and keeps read.follow to stream handlers", () => {
    const Posted = Actor.event("Posted", { text: Schema.String })

    class Missing extends Schema.TaggedError<Missing>()("Missing", {}) {}

    const Feed = Actor.stream("Feed", {
      payload: Schema.String,
      success: Schema.String,
      error: Missing,
    })

    const Peek = Actor.query("Peek", { success: Schema.Finite })

    const Room = Actor.make("StreamRoom", {
      key: Schema.String,
      events: [Posted],
      api: { Feed, Peek },
    })

    type Handle = Effect.Success<ReturnType<typeof Room.get>>

    expectTypeOf<ReturnType<Handle["Feed"]>>().toEqualTypeOf<
      Stream.Stream<
        string,
        | Missing
        | ActorError.Of<"ActorUnavailable" | "Unauthorized" | "RunnerAtCapacity" | "SessionEnded">
      >
    >()

    const follows = Room.toLayer(
      Effect.succeed({
        Feed: (after: string) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const read = yield* Room.Read

              return read.follow(Posted, { after }).pipe(
                Stream.map((entry) => entry.event.text),
                Stream.orDie,
              )
            }),
          ),
      }),
    )

    expectTypeOf(follows).toEqualTypeOf<Layer.Layer<never, never, InternalActors>>()

    const followsInQuery = Room.toQueryLayer(
      Effect.succeed({
        Peek: Effect.fnUntraced(function* () {
          const read = yield* Room.Read
          yield* read.follow(Posted).pipe(Stream.runDrain, Effect.orDie)

          return 1
        }),
      }),
    )

    expectTypeOf(followsInQuery).toEqualTypeOf<
      Layer.Layer<never, never, Context.Service.Identifier<typeof Actor.InStream> | InternalActors>
    >()

    type Served = ReturnType<ReturnType<typeof Room.client>["get"]>

    expectTypeOf<keyof Served & "Feed">().toEqualTypeOf<"Feed">()
    expectTypeOf<ReturnType<Served["Feed"]>>().toEqualTypeOf<AsyncIterable<string>>()
  })

  it("types read.progress and rejects progress of unbound or progress-less jobs", () => {
    const Render = Actor.job("Render", {
      payload: { job: Schema.String },
      progress: Schema.Struct({ percent: Schema.Finite }),
    })

    const Plain = Actor.job("Plain", { payload: { job: Schema.String } })

    const Percent = Actor.stream("Percent", {
      success: Schema.Finite,
      progress: { jobs: [Render] },
    })

    const Studio = Actor.make("ProgressStudio", {
      key: Schema.String,
      jobs: { Render: { job: Render } },
      api: { Percent },
    })

    const layer = Studio.toLayer(
      Effect.succeed({
        Percent: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              const read = yield* Studio.Read

              return read.progress(Render).pipe(Stream.map((entry) => entry.frame.percent))
            }),
          ),
      }),
    )

    expectTypeOf(layer).toEqualTypeOf<Layer.Layer<never, never, InternalActors>>()

    const Watch = Actor.connection("Watch", {
      server: Schema.String,
      progress: { jobs: [Render] },
    })

    expect(() => Actor.make("Unlisted", { key: Schema.String, api: { Watch } })).toThrow(
      "not a bound job",
    )

    const Loose = Actor.connection("Loose", {
      server: Schema.String,
      // @ts-expect-error only jobs that declare a progress schema report progress
      progress: { jobs: [Plain] },
    })

    expect(() =>
      Actor.make("Progressless", {
        key: Schema.String,
        jobs: { Plain: { job: Plain } },
        api: { Loose },
      }),
    ).toThrow("progress schema")
  })

  it("lets a turn mint only unkeyed actors that declare createdBy", () => {
    const Open = Actor.command("Open")
    const Mint = Actor.command("Mint")
    const Child = Actor.make("Child", { api: { Open }, createdBy: Open })
    const Plain = Actor.make("Plain", { api: { Open } })

    const Keyed = Actor.make("Keyed", {
      key: Schema.String,
      api: { Open },
      createdBy: Open,
    })

    const Single = Actor.make("Single", { key: Actor.singleton, api: { Open } })
    const Parent = Actor.make("Parent", { key: Schema.String, api: { Mint } })

    type TurnContext = (typeof Parent.Turn)["Service"]

    const mints = (turn: TurnContext) => {
      expectTypeOf(turn.mint(Child)).toEqualTypeOf<Effect.Effect<Parameters<typeof Child.get>[0]>>()
      // @ts-expect-error an actor without createdBy cannot be minted
      void turn.mint(Plain)
      // @ts-expect-error a keyed actor cannot be minted
      void turn.mint(Keyed)
      // @ts-expect-error a singleton cannot be minted
      void turn.mint(Single)
    }

    void mints
    // @ts-expect-error minting needs the turn context, which exists only inside a command turn
    void Child.mint
  })

  it("rejects mismatched keys, duplicates, reserved names, and foreign creation commands", () => {
    const Create = Actor.command("Create")
    const Increment = Actor.command("Increment", { payload: Schema.Finite, success: Schema.Finite })
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
    expect(() => Actor.make("Stateful", { api: { state: Actor.command("state") } })).toThrow(
      "reserved",
    )
    const Start = Actor.command("$workflow/start")
    expect(() => Actor.make("Prefixed", { api: { "$workflow/start": Start } })).toThrow("reserved")
    expect(() =>
      Actor.make("Prefixed", { api: { Increment }, internal: { $own: Actor.command("$own") } }),
    ).toThrow("reserved")
    expect(() =>
      Actor.make("Invalid", { api: { Increment }, policy: { maxStateBytes: 1.5 } }),
    ).toThrow()
    expect(() =>
      Actor.make("Invalid", { api: { Increment }, policy: { executionTimeout: 0 } }),
    ).toThrow()
    expect(() =>
      // @ts-expect-error createdBy must name a command of this actor
      Actor.make("Foreign", { api: { Increment }, createdBy: Create }),
    ).toThrow("createdBy must be a command of this actor")
  })

  it("publishes nothing from a rejected definition, so a later valid one may own its table", () => {
    const audit = Actor.table(pgTable("audit_declaration", { id: text("id").primaryKey() }))
    const Changed = Actor.event("Changed", {})

    class Reserved extends Schema.TaggedError<Reserved>()("ActorError", {}) {}

    const Ping = Actor.command("Ping")
    const Refused = Actor.command("Refused", { error: Reserved })

    expect(() =>
      Actor.make("RejectedEarly", { tables: [audit], events: [Changed, Changed], api: { Ping } }),
    ).toThrow("Duplicate event: Changed")
    expect(() => Actor.make("RejectedLate", { tables: [audit], api: { Refused } })).toThrow(
      "reserved",
    )
    expect(() => Actor.make("Accepted", { tables: [audit], api: { Ping } })).not.toThrow()
    expect(() => Actor.make("Intruder", { tables: [audit], api: { Ping } })).toThrow(
      "already owned by actor Accepted",
    )
  })

  it("places by tenant by default and by actor on request", () => {
    const Read = Actor.command("Read")
    const ref = { tenant: "t", actor: "Session", id: "a" }
    const other = { ...ref, id: "b" }
    expect(() => Actor.make("Session", { api: { Read }, placement: "actor" })).not.toThrow()
    expect(routingKey({ ref, placement: "tenant" })).toBe(
      routingKey({ ref: other, placement: "tenant" }),
    )
    expect(routingKey({ ref, placement: "actor" })).not.toBe(
      routingKey({ ref: other, placement: "actor" }),
    )
    expect(routingKey({ ref: { ...ref, tenant: "u" }, placement: "tenant" })).not.toBe(
      routingKey({ ref, placement: "tenant" }),
    )
    expect(() =>
      // @ts-expect-error placement is "tenant", "actor", or { parent }
      Actor.make("Bad", { api: { Read }, placement: "region" }),
    ).toThrow('placement is "tenant", "actor", or { parent }')
  })

  it("splits commands and queries between toLayer and toQueryLayer", () => {
    const Bump = Actor.command("Bump")
    const Peek = Actor.query("Peek", { success: Schema.Finite })

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
    // @ts-expect-error every command needs a handler in toLayer
    const _commands: Layer.Layer<never, never, InternalActors> = Box.toLayer({})
    // @ts-expect-error every query needs a handler in toQueryLayer
    const _queries: Layer.Layer<never, never, InternalActors> = Box.toQueryLayer({})

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

  it("lets only a query declared watch handle a watch, and only with X.Read", () => {
    class Clock extends Context.Service<Clock, { readonly tick: number }>()(
      "@rikalabs/akter/actor/definition.test/Clock",
    ) {}

    const Peek = Actor.query("Peek", { success: Schema.Finite, watch: true })
    const Plain = Actor.query("Plain", { success: Schema.Finite })
    const Bump = Actor.command("Bump")

    const Box = Actor.make("Box", {
      state: Actor.state({ n: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
      api: { Bump, Peek, Plain },
    })

    expect(Peek.watch).toBe(true)
    expect(Plain.watch).toBe(false)

    type Public = Effect.Success<ReturnType<typeof Box.create>>

    expectTypeOf<Public["Peek"]["watch"]>().toBeFunction()
    expectTypeOf<Public["Peek"]["watch"]>().returns.toEqualTypeOf<
      Stream.Stream<
        number,
        ActorError.Of<
          | "ActorUnavailable"
          | "Unauthorized"
          | "RunnerAtCapacity"
          | "SessionEnded"
          | "NotCreated"
          | "Timeout"
        >
      >
    >()
    expectTypeOf<Public["Plain"]>().not.toHaveProperty("watch")

    const reads = Box.toQueryLayer(
      Effect.succeed({
        Peek: Effect.fnUntraced(function* () {
          return (yield* Box.Read).state.n
        }),
        Plain: Effect.fnUntraced(function* () {
          yield* Clock

          return (yield* Box.Read).state.n
        }),
      }),
    )

    expectTypeOf(reads).toEqualTypeOf<
      Layer.Layer<never, never, Context.Service.Identifier<typeof Clock> | InternalActors>
    >()

    const onlyWatched = Box.toQueryLayer(
      Effect.succeed({
        Peek: Effect.fnUntraced(function* () {
          return (yield* Box.Read).state.n
        }),
        Plain: () => Effect.succeed(1),
      }),
    )

    expectTypeOf(onlyWatched).toEqualTypeOf<Layer.Layer<never, never, InternalActors>>()

    const watchesClock = Effect.fnUntraced(function* () {
      yield* Clock

      return 1
    })

    const _watched: Layer.Layer<never, never, InternalActors> = Box.toQueryLayer(
      // @ts-expect-error a watched handler may require nothing but X.Read
      Effect.succeed({
        Peek: watchesClock,
        Plain: () => Effect.succeed(1),
      }),
    )
  })

  it("resolves watch limits and bounds reconcileEvery from 5 seconds to 1 hour", () => {
    const Read = Actor.command("Read")

    const resolved = (watch?: { readonly reconcileEvery?: Duration.Input }) =>
      resolvePolicy({
        declared: watch === undefined ? undefined : { watch },
        createdBy: undefined,
        commands: [Read],
      })

    expect(resolved().watch).toEqual({
      maxPerActor: 1_000,
      minIntervalMs: 100,
      reconcileMs: 30_000,
    })
    expect(resolved({ reconcileEvery: "5 seconds" }).watch.reconcileMs).toBe(5_000)
    expect(resolved({ reconcileEvery: "1 hour" }).watch.reconcileMs).toBe(3_600_000)
    expect(() => resolved({ reconcileEvery: "4 seconds" })).toThrow()
    expect(() => resolved({ reconcileEvery: "2 hours" })).toThrow()
  })

  it("types turn.emit and read.events to the declared events of X.Turn and X.Read", () => {
    const Posted = Actor.event("Posted", { body: Schema.String })

    const Undeclared = Actor.event("Undeclared", {})

    const Post = Actor.command("Post")
    const History = Actor.query("History", { success: Schema.Array(Schema.String) })
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

    expectTypeOf<Effect.Services<typeof emits>>().toEqualTypeOf<
      Context.Service.Identifier<typeof Feed.Turn>
    >()
    // @ts-expect-error an effect that emits cannot run outside a turn
    const _outside = () => Effect.runPromise(emits)

    const _plain = Effect.gen(function* () {
      const turn = yield* Plain.Turn
      // @ts-expect-error an actor without events cannot emit
      yield* turn.emit(Posted.make({ body: "hi" }))
    })

    const reads = Feed.toQueryLayer(
      Effect.succeed({
        History: Effect.fnUntraced(function* () {
          const read = yield* Feed.Read
          const entries = yield* read.events(Posted, { after: "0" }).pipe(Effect.orDie)
          expectTypeOf(entries).toEqualTypeOf<ReadonlyArray<EventEntry<typeof Posted.Type>>>()

          return entries.map(({ event }) => event.body)
        }),
      }),
    )

    expectTypeOf(reads).toEqualTypeOf<Layer.Layer<never, never, InternalActors>>()

    const replay = Effect.gen(function* () {
      return yield* (yield* Feed.Read).events(Posted)
    })

    expectTypeOf<Effect.Error<typeof replay>>().toEqualTypeOf<UnknownCursor | RetentionGap>()

    const _misuse = (read: QueryContext<{}, typeof Posted>) => [
      // @ts-expect-error queries are read-only and cannot emit
      read.emit,
      // @ts-expect-error only declared event classes can be replayed
      read.events(Undeclared),
    ]
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
          payload: Schema.Finite,
          success: Schema.Finite,
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
    const Ping = Actor.command("Ping", { payload: Schema.String })
    const Wake = Actor.command("Wake")
    const Peek = Actor.query("Peek", { success: Schema.Finite })

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

    expectTypeOf(Target.intents("other")).not.toExtend<Effect.Effect<unknown>>()
    expectTypeOf(Intent.cancel("wake")).not.toExtend<Effect.Effect<unknown>>()

    const _requestReply: Layer.Layer<never, never, InternalActors> = Target.toLayer(
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
  it("types jobs, executors, and routes against the executor's return type", () => {
    const Moderate = Actor.job("Moderate", {
      payload: { body: Schema.String },
      success: Schema.Struct({ flagged: Schema.Boolean }),
    })

    const Other = Actor.job("Other")

    const Post = Actor.command("Post")

    const Moderated = Actor.command("Moderated", {
      payload: Schema.Struct({ flagged: Schema.Boolean }),
    })

    const Failed = Actor.command("Failed", { payload: Actor.DeadLetter(Moderate) })

    const Wrong = Actor.command("Wrong", { payload: Schema.String })

    const Room = Actor.make("JobTypes", {
      api: { Post },
      internal: { Moderated, Failed },
      jobs: {
        Moderate: {
          job: Moderate,
          retry: { times: 2 },
          onSuccess: Moderated,
          onDeadLetter: Failed,
        },
      },
    })

    const Flagged = Actor.command("Flagged", { payload: { flagged: Schema.Boolean } })

    const Audit = Actor.make("JobTypesAudit", {
      internal: { Flagged },
      jobs: { Moderate: { job: Moderate, onSuccess: Flagged, concurrency: { perActor: 1 } } },
    })

    expect(Moderate.tag).toBe("Moderate")
    const moderated = Moderate.make({ body: "hi" })
    expect(moderated).toBeInstanceOf(Moderate)
    expect(
      Result.flatMap(Schema.encodeResult(Moderate)(moderated), Schema.decodeResult(Moderate)),
    ).toEqual(Result.succeed(moderated))
    expectTypeOf(Moderate.make({ body: "hi" })).toEqualTypeOf<{
      readonly _tag: "Moderate"
      readonly body: string
    }>()
    expectTypeOf(Audit.api).toEqualTypeOf<{}>()

    type Executor = (typeof Room.Executor)["Service"]

    type Read = (typeof Room.Read)["Service"]

    expectTypeOf<Executor["jobId"]>().toEqualTypeOf<string>()
    expectTypeOf<Executor["attempt"]>().toEqualTypeOf<number>()
    expectTypeOf<keyof Read>().not.toEqualTypeOf<keyof Read | "enqueue">()

    Actor.make("WrongSuccess", {
      api: { Wrong },
      // @ts-expect-error onSuccess must accept the executor's return type
      jobs: { Moderate: { job: Moderate, onSuccess: Wrong } },
    })
    Actor.make("WrongDeadLetter", {
      api: { Moderated },
      // @ts-expect-error onDeadLetter must accept Actor.DeadLetter(J)
      jobs: { Moderate: { job: Moderate, onDeadLetter: Moderated } },
    })
    Actor.make("WrongCancelled", {
      api: { Moderated },
      // @ts-expect-error onCancelled must accept Actor.Cancelled(J)
      jobs: { Moderate: { job: Moderate, onCancelled: Moderated } },
    })
    expect(() =>
      Actor.make("ForeignRoute", {
        api: { Post },
        // @ts-expect-error a route must name a command of this actor
        jobs: { Moderate: { job: Moderate, onSuccess: Moderated } },
      }),
    ).toThrow("routes must name a command of this actor")
    expect(() =>
      Actor.make("MiskeyedJob", {
        api: { Post },
        // @ts-expect-error a binding is keyed by its job's tag
        jobs: { Other: { job: Moderate } },
      }),
    ).toThrow("keyed by its job's tag Moderate")
    expect(() =>
      Actor.make("BadRetry", {
        api: { Post },
        jobs: { Moderate: { job: Moderate, retry: { times: -1 } } },
      }),
    ).toThrow("jobs.Moderate.retry.times")

    for (const progressEvery of ["49 millis", "60000.5 millis", "61 seconds"] as const)
      expect(() =>
        Actor.make("BadProgressEvery", {
          api: { Post },
          jobs: { Moderate: { job: Moderate, progressEvery } },
        }),
      ).toThrow("progressEvery")

    const executors = Room.toJobLayer({ Moderate: () => Effect.succeed({ flagged: true }) })
    expectTypeOf(executors).toEqualTypeOf<Layer.Layer<never, never, InternalActors>>()

    const _wrong: Layer.Layer<never, never, InternalActors> = Room.toJobLayer({
      // @ts-expect-error an executor must return its job's success type
      Moderate: () => Effect.succeed("flagged"),
    })

    // @ts-expect-error every bound job needs an executor
    const _none: Layer.Layer<never, never, InternalActors> = Room.toJobLayer({})

    const layer = Room.toLayer({
      Post: Effect.fn(function* () {
        const turn = yield* Room.Turn
        yield* turn.enqueue(Moderate.make({ body: "hi" }))
        // @ts-expect-error only bound jobs can be enqueued
        yield* turn.enqueue(Other.make())
      }),
      Moderated: () => Effect.void,
      Failed: (letter) => Effect.log(letter.jobId, letter.job.body, letter.ambiguous),
    })

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

    const _typed = (read: ReadOf, turn: TurnOf) => {
      expectTypeOf(turn.blob(Files)).toEqualTypeOf<BlobWrite>()
      expectTypeOf(read.blob(Files)).toEqualTypeOf<BlobRead>()
    }

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
  it("declares content beside blobs; turns attach references and never read bytes", () => {
    const Files = Actor.blob("files")
    const Attachments = Actor.content("attachments")
    const Put = Actor.command("Put")
    const Peek = Actor.query("Peek")

    const Box = Actor.make("ContentBox", {
      key: Schema.String,
      blobs: [Files, Attachments],
      api: { Put, Peek },
    })

    type TurnOf = (typeof Box.Turn)["Service"]

    type ReadOf = (typeof Box.Read)["Service"]

    const _typed = (read: ReadOf, turn: TurnOf) => {
      expectTypeOf(turn.blob(Attachments)).toEqualTypeOf<ContentWrite>()
      expectTypeOf(read.blob(Attachments)).toEqualTypeOf<ContentRead>()
      expectTypeOf(turn.blob(Files)).toEqualTypeOf<BlobWrite>()
    }

    expectTypeOf<keyof ContentWrite>().toEqualTypeOf<"attach" | "detach" | "list">()
    expectTypeOf<keyof ContentRead>().toEqualTypeOf<"get" | "stream" | "list">()

    const _misuse = (read: ReadOf, turn: TurnOf) => [
      // @ts-expect-error a turn never reads content bytes
      turn.blob(Attachments).get("a"),
      // @ts-expect-error a query never attaches
      read.blob(Attachments).attach("a", { hash: "", size: 0, grant: "" }),
    ]

    expect(() => Actor.content("has space")).toThrow("Blob name")
    expect(() =>
      Actor.make("TwiceContent", { blobs: [Files, Actor.content("files")], api: { Put } }),
    ).toThrow("listed twice")
  })
  it("parses cron schedules and rejects bad expressions, duplicates, and targets", () => {
    const Tick = Actor.command("Tick")
    const Tock = Actor.command("Tock")
    const Set = Actor.command("Set", { payload: Schema.Finite })
    const Foreign = Actor.command("Foreign")

    expect(() =>
      Actor.make("Spaced", { api: { Tick, Tock }, schedules: { " 0  8 * * * ": Tick } }),
    ).not.toThrow()
    expect(() =>
      Actor.make("InternalTarget", {
        api: { Tock },
        internal: { Tick },
        schedules: { "0 8 * * *": Tick },
      }),
    ).not.toThrow()
    const Hourly = Actor.command("Hourly")
    const Secondly = Actor.command("Secondly")
    const Weekdays = Actor.command("Weekdays")

    expect(
      resolveSchedules({
        declared: {
          " 0  8 * * 1-5 ": Weekdays,
          "*/15 * * * *": Tick,
          "0-59 0-23 * 1-12 *": Tock,
          "0 * * * SUN": Hourly,
          "30 * * * * *": Secondly,
        },
        commands: [Tick, Tock, Hourly, Secondly, Weekdays],
      }).map((entry) => entry.key),
    ).toEqual([
      "$cron:UTC 0 8 * * 1,2,3,4,5",
      "$cron:UTC 0,15,30,45 * * * *",
      "$cron:UTC * * * * *",
      "$cron:UTC 0 * * * 0",
      "$cron:UTC 30 * * * * *",
    ])
    expect(
      resolveSchedules({
        declared: {
          "CRON_TZ=America/New_York  0 8 * * 1-5": Weekdays,
          "CRON_TZ=Europe/London 0 8 * * 1-5": Tick,
          "CRON_TZ=US/Eastern 0 8 * * 1-5": Tock,
          " @every  90 minutes ": Hourly,
          "@every 1 second": Secondly,
        },
        commands: [Tick, Tock, Hourly, Secondly, Weekdays],
      }).map((entry) => entry.key),
    ).toEqual([
      "$cron:America/New_York 0 8 * * 1,2,3,4,5",
      "$cron:Europe/London 0 8 * * 1,2,3,4,5",
      "$cron:US/Eastern 0 8 * * 1,2,3,4,5",
      "$cron:@every 5400000ms",
      "$cron:@every 1000ms",
    ])

    for (const [declaration, message] of [
      ["CRON_TZ=Mars/Olympus_Mons 0 8 * * *", "unknown time zone"],
      ["CRON_TZ=+05:00 0 8 * * *", "unknown time zone"],
      ["CRON_TZ=America/New_York 61 * * * *", "does not parse"],
      ["CRON_TZ=America/New_York @every 1 hour", "an interval takes no time zone"],
      ["@every 999 millis", "at least 1 second"],
      ["@every 1.5 seconds and more", "at least 1 second"],
      ["@every 1000.5 millis", "at least 1 second"],
      ["@every", "at least 1 second"],
    ] as const)
      expect(() =>
        resolveSchedules({ declared: { [declaration]: Tick }, commands: [Tick] }),
      ).toThrow(message)

    const repeats: ReadonlyArray<Readonly<Record<string, typeof Tick | typeof Tock>>> = [
      { "0 8 * * *": Tick, "CRON_TZ=UTC 0 8 * * *": Tock },
      { "@every 90 minutes": Tick, "@every 1.5 hours": Tock },
    ]

    for (const declared of repeats)
      expect(() => resolveSchedules({ declared, commands: [Tick, Tock] })).toThrow(
        "repeats the schedule",
      )
    expect(() =>
      Actor.make("Unparsable", { api: { Tick }, schedules: { "61 * * * *": Tick } }),
    ).toThrow("does not parse")
    expect(() =>
      Actor.make("Equal", {
        api: { Tick, Tock },
        schedules: { "0 8 * * *": Tick, "0  8 * * *": Tock },
      }),
    ).toThrow("repeats the schedule")
    expect(() =>
      Actor.make("Equivalent", {
        api: { Tick, Tock },
        schedules: { "0 8 * * 1-5": Tick, "0 8 * * 1,2,3,4,5": Tock },
      }),
    ).toThrow("repeats the schedule")
    expect(() =>
      // @ts-expect-error a cron target must be a command of this actor
      Actor.make("Foreigner", { api: { Tick }, schedules: { "0 8 * * *": Foreign } }),
    ).toThrow("command of this actor")
    expect(() =>
      Actor.make("WithInput", {
        api: { Set },
        // @ts-expect-error a cron target takes no input
        schedules: { "0 8 * * *": Set },
      }),
    ).toThrow("without input")
    expect(() =>
      Actor.make("BadSkip", {
        api: { Tick },
        policy: { cron: { "0 8 * * *": Tick }, maxScheduleLag: -1 },
      }),
    ).toThrow()
  })

  it("types subscriptions, their handlers, and turn.subscribe, and rejects bad declarations", () => {
    const Placed = Actor.event("Placed", { customer: Schema.String })

    const Cancelled = Actor.event("Cancelled", { customer: Schema.String })

    const Other = Actor.event("Other", {})

    const Noop = Actor.command("Noop")
    const Order = Actor.make("SubTypeOrder", { events: [Placed, Cancelled], api: { Noop } })

    const Picky = Actor.make("SubTypePicky", {
      events: [Placed],
      api: { Noop },
      policy: { allowedSubscriberTypes: ["SubTypeAllowed"] },
    })

    const OrderDelivery = Actor.Delivery({ source: Order, events: [Placed, Cancelled] })

    expect(OrderDelivery.source).toBe(Order)
    expect(OrderDelivery.events).toEqual([Placed, Cancelled])

    const Record = Actor.command("Record", { payload: OrderDelivery })

    const Routed = Actor.subscription("Routed", {
      delivery: OrderDelivery,
      handler: Record,
      route: (event) => {
        expectTypeOf(event).toEqualTypeOf<typeof Placed.Type | typeof Cancelled.Type>()

        return event.customer
      },
    })

    const Dynamic = Actor.subscription("Dynamic", { delivery: OrderDelivery, handler: Record })

    expect(Dynamic.source).toBe(Order)
    expect(Dynamic.events).toEqual([Placed, Cancelled])
    expect(() =>
      // @ts-expect-error the source doesn't declare Other
      Actor.Delivery({ source: Order, events: [Other] }),
    ).toThrow("does not declare event Other")
    expect(() => Actor.Delivery({ source: Order, events: [Placed, Placed] })).toThrow("twice")
    expect(() => Actor.Delivery({ source: Order, events: [] })).toThrow("names no event")

    const Narrow = Actor.command("Narrow", { payload: Schema.String })

    Actor.subscription("Mismatch", {
      delivery: Actor.Delivery({ source: Order, events: [Placed] }),
      // @ts-expect-error the handler's payload doesn't accept the delivery
      handler: Narrow,
    })

    const OnlyPlaced = Actor.subscription("OnlyPlaced", {
      delivery: Actor.Delivery({ source: Order, events: [Placed] }),
      handler: Record,
    })

    const Summary = Actor.make("SubTypeSummary", {
      key: Schema.String,
      api: { Noop },
      internal: { Record },
      subscriptions: [Routed, Dynamic, OnlyPlaced],
    })

    type Subscribe = (typeof Summary.Turn)["Service"]["subscribe"]

    expectTypeOf<Parameters<Subscribe>[0]>().toEqualTypeOf<typeof Dynamic | typeof OnlyPlaced>()
    // @ts-expect-error a routed subscription can't be subscribed to from a turn
    const _routed: Parameters<Subscribe>[0] = Routed
    expectTypeOf<keyof Effect.Success<ReturnType<typeof Summary.intents>>>().toEqualTypeOf<
      "ref" | "Noop"
    >()

    expect(() =>
      Actor.make("SubTypeTwice", {
        key: Schema.String,
        api: { Noop },
        internal: { Record },
        subscriptions: [Dynamic, Dynamic],
      }),
    ).toThrow("Duplicate subscription: Dynamic")
    expect(() =>
      Actor.make("SubTypePublic", {
        key: Schema.String,
        api: { Record },
        subscriptions: [Dynamic],
      }),
    ).toThrow("must be a command in internal")

    const PickyRecord = Actor.command("PickyRecord", {
      payload: Actor.Delivery({ source: Picky, events: [Placed] }),
    })

    const FromPicky = Actor.subscription("FromPicky", {
      delivery: PickyRecord.payload,
      handler: PickyRecord,
    })

    expect(() =>
      Actor.make("SubTypeExcluded", {
        key: Schema.String,
        api: { Noop },
        internal: { PickyRecord },
        subscriptions: [FromPicky],
      }),
    ).toThrow("policy.allowedSubscriberTypes does not allow SubTypeExcluded")
    expect(
      Actor.make("SubTypeAllowed", {
        key: Schema.String,
        api: { Noop },
        internal: { PickyRecord },
        subscriptions: [FromPicky],
      }).name,
    ).toBe("SubTypeAllowed")
    expect(() =>
      Actor.make("SubTypeSingletonRoute", {
        key: Schema.String,
        api: { Noop },
        internal: { Record },
        subscriptions: [
          Actor.subscription("ToSingleton", {
            delivery: OrderDelivery,
            handler: Record,
            route: Actor.singleton,
          }),
        ],
      }),
    ).toThrow("is keyed")
    expect(() => Intent.key("$feed")).toThrow("reserved")
  })
})
