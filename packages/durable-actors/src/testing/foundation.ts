import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  References,
  Schema,
} from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { Actor, Caller, NotCreated, Principal, System, Timeout, User } from "../index.ts"
import { Actors, Outcome, Request } from "../handles/actors.ts"
import { compress } from "../runtime/storage/codec.ts"
import { ActorTest, executeForTest } from "./actor-test.ts"
import type { ConformanceCase } from "./conformance.ts"

export interface RecordedDefect {
  readonly actor: string
  readonly id: string
  readonly command: string
  readonly cause: string
}

export interface FoundationFixture {
  creates: number
  privateRuns: number
  slowIds: Array<string>
  slowFirst: Effect.Effect<void>
  deliveryRuns: number
  deliveryHold: Effect.Effect<void>
  defects: Array<RecordedDefect>
}

export const foundationFixture = (): FoundationFixture => ({
  creates: 0,
  privateRuns: 0,
  slowIds: [],
  slowFirst: Effect.never,
  deliveryRuns: 0,
  deliveryHold: Effect.void,
  defects: [],
})

/** Captures the runtime's deterministic-defect log records, which replace the removed defect hook. */
export const defectRecorder = (fixture: FoundationFixture) =>
  Logger.layer(
    [
      Logger.make((options) => {
        const message = Array.isArray(options.message) ? options.message[0] : options.message

        if (message !== "Deterministic actor defect") return
        const annotations = options.fiber.getRef(References.CurrentLogAnnotations)

        fixture.defects.push({
          actor: String(annotations["actor"]),
          id: String(annotations["id"]),
          command: String(annotations["command"]),
          cause: Cause.pretty(options.cause),
        })
      }),
    ],
    { mergeWithExisting: true },
  )

const Ping = Actor.command("Ping", { output: Schema.String })

const Minted = Actor.make("Minted", { api: { Ping } })

const Named = Actor.make("Named", { key: Schema.NonEmptyString, api: { Ping } })

const Singleton = Actor.make("Singleton", { key: Actor.singleton, api: { Ping } })

class CreationRejected extends Schema.TaggedError<CreationRejected>()("CreationRejected", {}) {}

const Create = Actor.command("Create", { input: Schema.Boolean, errors: [CreationRejected] })

const Read = Actor.command("Read", { output: Schema.Finite })

const Created = Actor.make("Created", {
  key: Schema.NonEmptyString,
  state: { count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) },
  api: { Create, Read },
  policy: { createdBy: Create },
})

const SetText = Actor.command("SetText", { input: Schema.String, output: Schema.String })

const Small = Actor.make("Small", {
  key: Schema.NonEmptyString,
  state: { text: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))) },
  api: { SetText },
  policy: { maxStateBytes: 15, commandTimeout: "500 millis" },
})

const Attribution = Schema.Struct({ caller: Caller, principal: Schema.NullOr(Principal) })

const Who = Actor.command("Who", { output: Attribution })

const Internal = Actor.command("Internal", { output: Attribution })

const Private = Actor.make("Private", {
  key: Schema.NonEmptyString,
  api: { Who },
  internal: { Internal },
})

const Bump = Actor.command("Bump", { output: Schema.Finite })

const Slow = Actor.make("Slow", {
  key: Schema.NonEmptyString,
  state: { count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) },
  api: { Read, Bump },
  policy: { commandTimeout: "500 millis" },
})

const DeliveryActor = Actor.make("DeliveryActor", {
  key: Schema.NonEmptyString,
  state: { count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) },
  api: { Bump },
  policy: { deliveryTimeout: "100 millis" },
})

const attribution = (turn: {
  readonly caller: Caller
  readonly principal: Option.Option<Principal>
}) => ({
  caller: turn.caller,
  principal: Option.getOrNull(turn.principal),
})

export const foundationLayer = (fixture: FoundationFixture) =>
  Layer.mergeAll(
    Minted.toLayer(Effect.succeed({ Ping: () => Effect.succeed("minted") })),
    Named.toLayer(Effect.succeed({ Ping: () => Effect.succeed("named") })),
    Singleton.toLayer(Effect.succeed({ Ping: () => Effect.succeed("singleton") })),
    Created.toLayer(
      Effect.succeed({
        Create: Effect.fnUntraced(function* (accept: boolean) {
          const turn = yield* Created.Turn
          fixture.creates += 1
          yield* turn.state.set({ count: 23 })

          if (!accept) return yield* CreationRejected.make({})
        }),
        Read: Effect.fnUntraced(function* () {
          return (yield* Created.Turn).state.count
        }),
      }),
    ),
    Small.toLayer(
      Effect.succeed({
        SetText: Effect.fnUntraced(function* (text: string) {
          const turn = yield* Small.Turn
          yield* turn.state.set({ text })

          return turn.state.text
        }),
      }),
    ),
    Private.toLayer(
      Effect.succeed({
        Who: Effect.fnUntraced(function* () {
          return attribution(yield* Private.Turn)
        }),
        Internal: Effect.fnUntraced(function* () {
          fixture.privateRuns += 1

          return attribution(yield* Private.Turn)
        }),
      }),
    ),
    Slow.toLayer(
      Effect.succeed({
        Read: Effect.fnUntraced(function* () {
          return (yield* Slow.Turn).state.count
        }),
        Bump: Effect.fnUntraced(function* () {
          const turn = yield* Slow.Turn
          fixture.slowIds.push(turn.commandId)
          yield* turn.state.set({ count: turn.state.count + 1 })

          if (fixture.slowIds.length === 1) yield* fixture.slowFirst

          return turn.state.count
        }),
      }),
    ),
    DeliveryActor.toLayer(
      Effect.succeed({
        Bump: Effect.fnUntraced(function* () {
          const turn = yield* DeliveryActor.Turn
          fixture.deliveryRuns += 1
          yield* turn.state.set({ count: turn.state.count + 1 })
          yield* fixture.deliveryHold

          return turn.state.count
        }),
      }),
    ),
  )

export const foundationConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "resolves all identity modes without writes and receipts stateless commands",
    run: ({ environment, expect }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const minted = yield* Minted.create()
          expect(Schema.is(Schema.String.check(Schema.isUUID(7)))(minted.ref.id)).toBe(true)
          const other = yield* Minted.create()
          expect(minted.ref.id).not.toBe(other.ref.id)
          const named = yield* Named.get("chosen")
          const singleton = yield* Singleton.get()
          expect((yield* Singleton.get()).ref).toEqual(singleton.ref)

          for (const handle of [minted, other, named, singleton])
            expect(yield* test.inspect(handle.ref)).toEqual({
              generation: undefined,
              state: {},
              receipts: 0,
            })
          expect(yield* minted.Ping()).toBe("minted")
          expect(yield* named.Ping()).toBe("named")
          const call = singleton.Ping()
          expect(yield* call).toBe("singleton")
          expect(yield* call).toBe("singleton")
          expect(yield* test.inspect(singleton.ref)).toEqual({
            generation: "1",
            state: {},
            receipts: 1,
          })
        }),
      ),
  },
  {
    name: "gates creation, rolls back failed creation, and replays its error receipt",
    run: ({ environment, expect, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const actor = yield* Created.get("creation")
          expect(yield* actor.Read().pipe(Effect.flip)).toMatchObject({
            reason: NotCreated.make({}),
          })
          expect(yield* test.inspect(actor.ref)).toEqual({
            generation: undefined,
            state: {},
            receipts: 0,
          })
          const reject = actor.Create(false)
          const before = fixture.foundation.creates
          expect(yield* reject.pipe(Effect.flip)).toBeInstanceOf(CreationRejected)
          expect(yield* reject.pipe(Effect.flip)).toBeInstanceOf(CreationRejected)
          expect(fixture.foundation.creates - before).toBe(1)
          expect(yield* test.inspect(actor.ref)).toEqual({
            generation: "1",
            state: {},
            receipts: 1,
          })
          expect(yield* actor.Read().pipe(Effect.flip)).toMatchObject({
            reason: NotCreated.make({}),
          })
          yield* actor.Create(true)
          expect(yield* actor.Read()).toBe(23)
        }),
      ),
  },
  ...(["beforeCommit", "afterCommit"] as const).map((point): ConformanceCase => ({
    name: `keeps creation marker and receipt atomic across ${point} crash`,
    run: ({ environment, expect, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const actor = yield* Created.get(`creation-${point}`)
          const before = fixture.foundation.creates
          yield* test.crashNext(point)
          yield* actor.Create(true)
          expect(fixture.foundation.creates - before).toBe(point === "beforeCommit" ? 2 : 1)
          expect(yield* test.inspect(actor.ref)).toMatchObject({
            state: { count: 23 },
            receipts: 1,
          })
          expect(yield* actor.Read()).toBe(23)
        }),
      ),
  })),
  {
    name: "retains creation and singleton receipt identity across runtime restart",
    run: ({ environment, expect }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const saved = yield* Effect.promise(() =>
            environment.run(
              Effect.gen(function* () {
                const actor = yield* Created.get("restart-created")
                yield* actor.Create(true)
                const singleton = yield* Singleton.get()
                const id = yield* (yield* Actors).mintCommandId
                expect(yield* singleton.Ping().pipe(Actor.commandId(id))).toBe("singleton")

                return { tenant: actor.ref.tenant, id, singleton: singleton.ref }
              }),
            ),
          )

          yield* environment.restart
          yield* Effect.promise(() =>
            environment.run(
              Effect.gen(function* () {
                expect(
                  yield* (yield* Created.get("restart-created").pipe(
                    Actor.tenant(saved.tenant),
                  )).Read(),
                ).toBe(23)
                const singleton = yield* Singleton.get().pipe(Actor.tenant(saved.tenant))
                expect(singleton.ref).toEqual(saved.singleton)
                const test = yield* ActorTest
                const before = yield* test.inspect(singleton.ref)
                expect(yield* singleton.Ping().pipe(Actor.commandId(saved.id))).toBe("singleton")
                expect(yield* test.inspect(singleton.ref)).toEqual(before)
              }),
            ),
          )
        }),
      ),
  },
  {
    name: "enforces UTF-8 state bytes and records deterministic defects without user hooks",
    run: ({ environment, expect, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const actor = yield* Small.get("bytes")
          expect(yield* actor.SetText("éé")).toBe("éé") // {"text":"éé"} is exactly 15 UTF-8 bytes.
          const before = yield* test.inspect(actor.ref)
          const defects = fixture.foundation.defects.length
          const failure = yield* actor.SetText("ééa").pipe(Effect.exit)
          expect(Exit.isFailure(failure) && Cause.pretty(failure.cause)).toContain(
            "policy.maxStateBytes",
          )
          expect(yield* test.inspect(actor.ref)).toEqual(before)
          expect(fixture.foundation.defects.length).toBe(defects + 1)
          expect(fixture.foundation.defects.at(-1)).toMatchObject({
            actor: "Small",
            id: "bytes",
            command: "SetText",
          })
          expect(fixture.foundation.defects.at(-1)!.cause).toContain("policy.maxStateBytes")
          expect(yield* actor.SetText("abc")).toBe("abc")
          expect((yield* test.inspect(actor.ref)).generation).toBe(before.generation)
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE actor_state SET value = ${compress("13")} WHERE tenant_id = ${actor.ref.tenant} AND actor_type = 'Small' AND actor_id = 'bytes'`
          // A warm activation trusts its cached committed state (ADR 0005);
          // advancing the generation forces the next turn to reload the row.
          yield* test.invalidate(actor.ref)
          expect(Exit.isFailure(yield* actor.SetText("ok").pipe(Effect.exit))).toBe(true)
          expect(fixture.foundation.defects.length).toBe(defects + 2)
          expect(yield* test.inspect(actor.ref)).toMatchObject({ state: { text: 13 }, receipts: 2 })
        }),
      ),
  },
  {
    name: "hides internal commands and binds System principal and receipt access",
    run: ({ environment, expect, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const actor = yield* Private.get("private")
          expect(Object.keys(actor).sort()).toEqual(["Who", "ref"])
          expect(Object.keys(Private.api)).toEqual(["Who"])
          expect(yield* actor.Who()).toEqual({
            caller: User.make({ subject: "alice" }),
            principal: { subject: "alice" },
          })
          const bound = yield* test.actor(Private, "private")
          const id = yield* (yield* Actors).mintCommandId

          const expected = {
            caller: System.make({ source: "actor", onBehalfOf: { subject: "alice" } }),
            principal: { subject: "alice" },
          }

          expect(yield* bound.system.Internal().pipe(Actor.commandId(id))).toEqual(expected)
          expect(yield* bound.system.Internal().pipe(Actor.commandId(id))).toEqual(expected)
          const actors = yield* Actors
          const attempts = fixture.foundation.privateRuns

          const denied = yield* executeForTest(
            Request.make({
              ref: actor.ref,
              caller: User.make({ subject: "alice" }),
              command: "Internal",
              commandId: yield* actors.mintCommandId,
              payload: "{}",
            }),
          )

          expect(Outcome.guards.Defect(denied)).toBe(true)
          expect(fixture.foundation.defects.at(-1)).toMatchObject({
            actor: "Private",
            command: "Internal",
          })

          for (const caller of [
            System.make({ source: "workflow", onBehalfOf: { subject: "alice" } }),
            System.make({ source: "actor", ref: actor.ref, onBehalfOf: { subject: "alice" } }),
            System.make({ source: "actor", onBehalfOf: { subject: "bob" } }),
          ])
            expect(
              yield* executeForTest(
                Request.make({
                  ref: actor.ref,
                  caller,
                  command: "Internal",
                  commandId: id,
                  payload: "{}",
                }),
              ).pipe(Effect.flip),
            ).toMatchObject({ reason: { code: "receipt_access_denied" } })
          expect(fixture.foundation.privateRuns).toBe(attempts)
          expect((yield* bound.inspect).receipts).toBe(2)
        }),
      ),
  },
  ...(["execution timeout", "retryable SQL defect"] as const).map((failure): ConformanceCase => ({
    name: `retries the same command after ${failure} without a partial commit`,
    run: ({ environment, expect, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const actor = yield* Slow.get(failure)
          const test = yield* ActorTest
          expect(yield* actor.Read()).toBe(0)
          const before = yield* test.inspect(actor.ref)
          fixture.foundation.slowIds = []
          fixture.foundation.slowFirst =
            failure === "execution timeout"
              ? Effect.never
              : Effect.die(
                  SqlError.SqlError.make({
                    reason: SqlError.DeadlockError.make({ cause: new Error("injected deadlock") }),
                  }),
                )
          const id = yield* (yield* Actors).mintCommandId
          expect(yield* actor.Bump().pipe(Actor.commandId(id))).toBe(1)
          expect(fixture.foundation.slowIds).toEqual([id, id])
          expect(yield* test.inspect(actor.ref)).toEqual({
            state: { count: 1 },
            receipts: 2,
            generation: String(Number(before.generation) + 1),
          })
        }),
      ),
  })),
  {
    name: "delivery timeout stops waiting while the admitted command commits once",
    run: ({ environment, expect, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const actor = yield* DeliveryActor.get("delivery")
          const reached = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          fixture.foundation.deliveryHold = Deferred.succeed(reached, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          )
          fixture.foundation.deliveryRuns = 0
          const id = yield* (yield* Actors).mintCommandId
          const pending = yield* actor.Bump().pipe(Actor.commandId(id), Effect.forkScoped)
          yield* Deferred.await(reached)
          expect(yield* Fiber.join(pending).pipe(Effect.flip)).toMatchObject({
            reason: Timeout.make({ commandId: id }),
            isRetryable: true,
          })

          // A receipt retry may wait for PGlite's busy connection before admission.
          // Its delivery deadline must cover that wait, not just the RPC reply.
          const retry = yield* actor
            .Bump()
            .pipe(
              Actor.commandId(id),
              Effect.flip,
              Effect.timeout("2 seconds"),
              Effect.ensuring(Deferred.succeed(release, undefined)),
            )

          expect(retry).toMatchObject({ reason: Timeout.make({ commandId: id }) })
          yield* Deferred.succeed(release, undefined)
          const test = yield* ActorTest
          yield* test
            .inspect(actor.ref)
            .pipe(
              Effect.repeat({ while: (state) => state.receipts === 0, times: 100 }),
              Effect.timeout("5 seconds"),
            )
          expect(yield* actor.Bump().pipe(Actor.commandId(id))).toBe(1)
          expect(fixture.foundation.deliveryRuns).toBe(1)
          expect(yield* test.inspect(actor.ref)).toEqual({
            state: { count: 1 },
            receipts: 1,
            generation: "1",
          })
        }),
      ),
  },
]
