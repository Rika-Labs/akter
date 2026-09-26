import { Cause, Clock, Effect, Exit, Fiber, Layer, Option, Schema, Scope } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Intent, RetentionGap, UnknownCursor } from "../../index.ts"
import { ActorError, CommandExpired, Timeout } from "../../errors/actor.ts"
import { databaseTime } from "../../runtime/turn/admission.ts"
import { ActorTest } from "../actor-test.ts"
import type {
  ConformanceCase,
  ConformanceEnvironment,
  ConformanceServices,
} from "../conformance.ts"

export interface RetentionFixture {
  /** `Add` handler runs, including runs whose turn later rolled back. */
  adds: number
  /** `Receive` handler runs. */
  receives: number
}

export const retentionFixture = (): RetentionFixture => ({ adds: 0, receives: 0 })

class Noted extends Actor.Event<Noted>()("Noted", { body: Schema.String }) {}

const files = Actor.blob("files")

const Note = Actor.command("Note", { input: Schema.String, output: Schema.String })

const NoteMany = Actor.command("NoteMany", {
  input: Schema.Struct({ count: Schema.Int, bytes: Schema.Int }),
})

const Add = Actor.command("Add", { input: Schema.Int, output: Schema.Int })

const Forward = Actor.command("Forward", { input: Schema.String })

const Receive = Actor.command("Receive", { input: Schema.String })

const Put = Actor.command("Put", {
  input: Schema.Struct({ name: Schema.String, bytes: Schema.Int }),
})

const Grow = Actor.command("Grow", {
  input: Schema.Struct({ name: Schema.String, bytes: Schema.Int }),
})

/** Replaces an entry and swallows the defect, so the turn commits whatever the write left. */
const PutCaught = Actor.command("PutCaught", {
  input: Schema.Struct({ name: Schema.String, bytes: Schema.Int }),
  output: Schema.Boolean,
})

const Entry = Schema.Struct({ cursor: Schema.String, body: Schema.String })

const History = Actor.query("History", {
  input: Schema.Struct({
    after: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Finite),
  }),
  output: Schema.Array(Entry),
  errors: [UnknownCursor, RetentionGap],
})

const Size = Actor.query("Size", { input: Schema.String, output: Schema.Int })

const Total = Actor.query("Total", { output: Schema.Int })

const Journal = Actor.make("Journal", {
  key: Schema.String,
  state: Actor.state({ total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  events: [Noted],
  blobs: [files],
  api: { Note, NoteMany, Add, Forward, Put, Grow, PutCaught, History, Size, Total },
  internal: { Receive },
  policy: {
    keepReceipts: "2 days",
    keepEvents: "1 day",
    maxBlobBytes: 1024,
    commandTimeout: "2 seconds",
  },
})

/** The same events under a longer horizon, so one sweep applies each type's own policy. */
const Chronicle = Actor.make("Chronicle", {
  key: Schema.String,
  events: [Noted],
  api: { Note },
  policy: { keepEvents: "90 days" },
})

export const retentionLayer = (fixture: RetentionFixture) =>
  Layer.mergeAll(
    Journal.toLayer(
      Effect.succeed({
        Forward: Effect.fnUntraced(function* (to: string) {
          yield* Journal.Turn
          yield* (yield* Journal.intents(to)).Receive("forwarded").pipe(Intent.after("1 minute"))
        }),
        Note: Effect.fnUntraced(function* (body: string) {
          const turn = yield* Journal.Turn
          yield* turn.emit(Noted.make({ body }))

          return turn.commandId
        }),
        NoteMany: Effect.fnUntraced(function* ({ count, bytes }) {
          const turn = yield* Journal.Turn

          for (let index = 0; index < count; index++)
            yield* turn.emit(Noted.make({ body: "x".repeat(bytes) }))
        }),
        Add: Effect.fnUntraced(function* (amount: number) {
          const turn = yield* Journal.Turn
          fixture.adds += 1
          yield* turn.state.set({ total: turn.state.total + amount })

          return turn.state.total
        }),
        Receive: Effect.fnUntraced(function* () {
          const turn = yield* Journal.Turn
          fixture.receives += 1
          yield* turn.state.set({ total: turn.state.total + 1 })
        }),
        Put: Effect.fnUntraced(function* ({ name, bytes }) {
          yield* (yield* Journal.Turn).blob(files).set(name, new Uint8Array(bytes))
        }),
        Grow: Effect.fnUntraced(function* ({ name, bytes }) {
          yield* (yield* Journal.Turn).blob(files).append(name, new Uint8Array(bytes))
        }),
        PutCaught: Effect.fnUntraced(function* ({ name, bytes }) {
          return yield* (yield* Journal.Turn)
            .blob(files)
            .set(name, new Uint8Array(bytes))
            .pipe(
              Effect.as(true),
              Effect.catchDefect(() => Effect.succeed(false)),
            )
        }),
      }),
    ),
    Journal.toQueryLayer(
      Effect.succeed({
        History: Effect.fnUntraced(function* ({ after, limit }) {
          const read = yield* Journal.Read
          const entries = yield* read.events(Noted, { after, limit })

          return entries.map(({ cursor, event }) => ({ cursor, body: event.body }))
        }),
        Size: Effect.fnUntraced(function* (name: string) {
          const bytes = yield* (yield* Journal.Read).blob(files).get(name)

          return Option.match(bytes, { onNone: () => -1, onSome: (value) => value.byteLength })
        }),
        Total: Effect.fnUntraced(function* () {
          return (yield* Journal.Read).state.total
        }),
      }),
    ),
    Chronicle.toLayer(
      Effect.succeed({
        Note: Effect.fnUntraced(function* (body: string) {
          const turn = yield* Chronicle.Turn
          yield* turn.emit(Noted.make({ body }))

          return turn.commandId
        }),
      }),
    ),
  )

const defect = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "succeeded"

const cursors = (entries: ReadonlyArray<typeof Entry.Type>) => entries.map(({ cursor }) => cursor)

/**
 * Runs `effect` in a runtime of its own on a fresh database, so the cases that
 * move the framework clock days ahead never age another case's rows.
 */
const isolated = <A, E>(
  environment: ConformanceEnvironment,
  effect: Effect.Effect<A, E, ConformanceServices | Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* environment.freshDatabase

      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() => environment.build({ database })),
        (built) => Effect.promise(() => built.dispose()),
      )

      return yield* Effect.promise(() => runtime.runPromise(Effect.scoped(effect)))
    }).pipe(Effect.scoped),
  )

const eventSequence = Effect.fnUntraced(function* (id: string) {
  const sql = yield* SqlClient.SqlClient
  const test = yield* ActorTest

  const [row] = yield* sql<{ sequence: string }>`
    SELECT event_sequence::text AS sequence FROM actor_generations
    WHERE tenant_id = ${test.tenant} AND actor_type = 'Journal' AND actor_id = ${id}`

  return row?.sequence
}, Effect.orDie)

export const retentionConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "prunes receipts past keepReceipts and still rejects the expired id after pruning and restart",
    run: ({ expect, environment, fixture }) =>
      isolated(
        environment,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const journal = yield* Journal.get("receipts")
          const before = fixture.retention.adds
          const add = journal.Add(3)
          expect(yield* add).toBe(3)
          expect(yield* journal.Add(4)).toBe(7)

          // Past its id's expiry but inside keepReceipts: kept, and the retry is already expired.
          yield* test.advance("1 day")
          expect(yield* test.cleanup).toMatchObject({ receipts: 0 })
          expect(yield* test.inspect(journal.ref)).toMatchObject({ receipts: 2 })
          expect((yield* add.pipe(Effect.flip)).reason).toBeInstanceOf(CommandExpired)

          yield* test.advance("2 days")
          expect(yield* test.cleanup).toMatchObject({ receipts: 2 })
          expect(yield* test.inspect(journal.ref)).toMatchObject({
            receipts: 0,
            state: { total: 7 },
          })
          expect((yield* add.pipe(Effect.flip)).reason).toBeInstanceOf(CommandExpired)
          expect(fixture.retention.adds - before).toBe(2)
          expect(yield* journal.Total()).toBe(7)
        }),
      ),
  },
  {
    name: "rejects a pruned expired id after restart without running its handler",
    run: ({ expect, environment, fixture }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          // One runtime at a time on the retained database, which PGlite needs.
          yield* environment.stop
          const first = environment.build()

          // The first runtime commits, then prunes the receipt past both horizons.
          const saved = yield* Effect.promise(() =>
            first
              .runPromise(
                Effect.scoped(
                  Effect.gen(function* () {
                    const test = yield* ActorTest
                    const journal = yield* Journal.get("restart")
                    const now = yield* databaseTime
                    const id = `v1.${now - 59_000}.${now + 1_000}.6f6f1e0a-3a42-4c1e-9d6b-2b1c1f1a9e01`
                    expect(yield* journal.Add(5).pipe(Actor.commandId(id))).toBe(5)
                    yield* test.advance("3 days")
                    yield* test.cleanup
                    expect(yield* test.inspect(journal.ref)).toMatchObject({ receipts: 0 })

                    return { id, tenant: test.tenant }
                  }),
                ),
              )
              .finally(() => first.dispose()),
          )

          const adds = fixture.retention.adds
          const second = environment.build()

          yield* Effect.promise(() =>
            second
              .runPromise(
                Effect.scoped(
                  Effect.gen(function* () {
                    const journal = yield* Journal.get("restart").pipe(Actor.tenant(saved.tenant))

                    // The restarted clock has no advance; real time passes the id's expiry.
                    yield* Effect.sleep("1100 millis")

                    const failure = yield* journal
                      .Add(5)
                      .pipe(Actor.commandId(saved.id), Effect.flip)

                    expect(failure.reason).toBeInstanceOf(CommandExpired)
                    expect(yield* journal.Total()).toBe(5)
                  }),
                ),
              )
              .finally(() => second.dispose()),
          )

          expect(fixture.retention.adds).toBe(adds)
        }).pipe(Effect.ensuring(environment.restart)),
      ),
  },
  {
    name: "prunes receipts past keepReceipts without breaking outbox dedup",
    run: ({ expect, environment, fixture }) =>
      isolated(
        environment,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sender = yield* Journal.get("sender")
          const receiver = yield* Journal.get("receiver")
          const before = fixture.retention.receives
          yield* sender.Forward("receiver")

          // The first delivery crashes before deleting the sender's row; the
          // redelivery pauses there, days past the receipt's horizon.
          yield* test.crashNext("beforeOutboxDelete")
          const pause = yield* test.pauseNext("beforeOutboxDelete")
          const draining = yield* test.advance("10 days").pipe(Effect.forkChild)
          yield* pause.reached
          expect(yield* test.receiptsFor(receiver.ref, "Receive")).toBe(1)
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 1 })

          // The row can still be redelivered, so its receipt stays.
          yield* test.cleanup
          expect(yield* test.receiptsFor(receiver.ref, "Receive")).toBe(1)
          yield* pause.release
          yield* Fiber.join(draining)

          expect(fixture.retention.receives - before).toBe(1)
          expect(yield* receiver.Total()).toBe(1)
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 0 })

          // Once the row is gone, nothing can redeliver the id.
          yield* test.cleanup
          expect(yield* test.receiptsFor(receiver.ref, "Receive")).toBe(0)
        }),
      ),
  },
  {
    name: "prunes only an actor's oldest events, never resets the sequence, and reports the gap",
    run: ({ expect, environment }) =>
      isolated(
        environment,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const journal = yield* Journal.get("events")
          const chronicle = yield* Chronicle.get("events")
          yield* journal.Note("a")
          yield* journal.Note("b")
          yield* chronicle.Note("kept")
          yield* test.advance("2 days")
          yield* journal.Note("c")

          expect(yield* test.cleanup).toMatchObject({ events: 2 })
          expect(yield* test.inspect(journal.ref)).toMatchObject({ events: 1 })
          expect(yield* test.inspect(chronicle.ref)).toMatchObject({ events: 1 })
          expect(yield* eventSequence("events")).toBe("3")

          expect(yield* journal.History({}).pipe(Effect.flip)).toEqual(
            RetentionGap.make({ cursor: "0" }),
          )
          expect(yield* journal.History({ after: "1" }).pipe(Effect.flip)).toEqual(
            RetentionGap.make({ cursor: "1" }),
          )
          expect(yield* journal.History({ after: "2" })).toEqual([{ cursor: "3", body: "c" }])

          yield* journal.Note("d")
          expect(cursors(yield* journal.History({ after: "2" }))).toEqual(["3", "4"])
          expect(yield* eventSequence("events")).toBe("4")
        }),
      ),
  },
  {
    name: "prunes events as a prefix even when a later event carries an older timestamp",
    run: ({ expect, environment }) =>
      isolated(
        environment,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sql = yield* SqlClient.SqlClient
          const journal = yield* Journal.get("skewed")

          for (const body of ["a", "b", "c", "d"]) yield* journal.Note(body)

          // A clock step back gave event 3 the oldest timestamp.
          yield* sql`UPDATE actor_events SET emitted_at_ms = emitted_at_ms - 172800000
            WHERE tenant_id = ${test.tenant} AND actor_type = 'Journal' AND actor_id = 'skewed' AND sequence = 3`

          expect(yield* test.cleanup).toMatchObject({ events: 3 })
          expect(yield* journal.History({ after: "3" })).toEqual([{ cursor: "4", body: "d" }])
          expect(yield* journal.History({ after: "2" }).pipe(Effect.flip)).toEqual(
            RetentionGap.make({ cursor: "2" }),
          )
        }),
      ),
  },
  {
    name: "sweeps in batches that each leave a whole prefix",
    run: ({ expect, environment }) =>
      isolated(
        environment,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const journal = yield* Journal.get("batched")
          yield* journal.NoteMany({ count: 2_500, bytes: 1 })
          yield* test.advance("2 days")
          yield* journal.Note("fresh")

          expect(yield* test.cleanup).toMatchObject({ events: 2_500 })
          expect(yield* journal.History({ after: "2500" })).toEqual([
            { cursor: "2501", body: "fresh" },
          ])
          expect(yield* eventSequence("batched")).toBe("2501")
        }),
      ),
  },
  {
    name: "pages event replay by limit and continues after the last cursor",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const journal = yield* Journal.get("paged")
          yield* journal.NoteMany({ count: 1_205, bytes: 1 })

          const first = yield* journal.History({})
          expect(first.length).toBe(1_000)
          expect(first.at(-1)!.cursor).toBe("1000")
          expect((yield* journal.History({ after: "1000" })).length).toBe(205)

          const small = yield* journal.History({ after: "10", limit: 3 })
          expect(cursors(small)).toEqual(["11", "12", "13"])
          expect(cursors(yield* journal.History({ after: "1203", limit: 3 }))).toEqual([
            "1204",
            "1205",
          ])
          expect(yield* journal.History({ after: "1205", limit: 3 })).toEqual([])

          for (const limit of [0, 10_001, 1.5])
            expect(defect(yield* journal.History({ limit }).pipe(Effect.exit))).toContain(
              "read.events limit must be an integer from 1 to 10000",
            )
        }),
      ),
  },
  {
    name: "fails a turn whose emits exceed the per-turn byte budget and commits none of them",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const journal = yield* Journal.get("budget")
          yield* journal.NoteMany({ count: 2, bytes: 500_000 })
          expect(yield* test.inspect(journal.ref)).toMatchObject({ events: 2, receipts: 1 })

          expect(
            defect(yield* journal.NoteMany({ count: 3, bytes: 500_000 }).pipe(Effect.exit)),
          ).toContain("Events emitted in one turn exceed 1048576 bytes")
          expect(yield* test.inspect(journal.ref)).toMatchObject({ events: 2, receipts: 1 })
          expect(yield* eventSequence("budget")).toBe("2")
        }),
      ),
  },
  {
    name: "refuses blob writes past policy.maxBlobBytes and leaves the entry whole",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const journal = yield* Journal.get("quota")
          yield* journal.Put({ name: "a", bytes: 600 })
          yield* journal.Grow({ name: "b", bytes: 200 })
          yield* journal.Grow({ name: "b", bytes: 200 })

          expect(defect(yield* journal.Grow({ name: "b", bytes: 25 }).pipe(Effect.exit))).toContain(
            "One actor's blobs hold at most 1024 bytes (policy.maxBlobBytes)",
          )
          expect(defect(yield* journal.Put({ name: "c", bytes: 25 }).pipe(Effect.exit))).toContain(
            "policy.maxBlobBytes",
          )

          // Replacing an entry counts only its new bytes.
          yield* journal.Put({ name: "a", bytes: 624 })
          expect(yield* journal.Size("a")).toBe(624)

          // A refused replacement caught in the handler still leaves both chunks of "b".
          expect(yield* journal.PutCaught({ name: "b", bytes: 500 })).toBe(false)
          expect(yield* journal.Size("b")).toBe(400)
          expect(yield* journal.PutCaught({ name: "b", bytes: 100 })).toBe(true)
          expect(yield* journal.Size("b")).toBe(100)
          expect(yield* test.inspect(journal.ref)).toMatchObject({ blobs: { files: 2 } })
        }),
      ),
  },
  {
    name: "rejects a retry admitted before expiry when cleanup pruned the receipt before its turn",
    requiresIndependentConnections: true,
    timeoutMs: 20_000,
    run: ({ expect, environment, fixture }) =>
      isolated(
        environment,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const journal = yield* Journal.get("race")
          const before = fixture.retention.adds
          const now = yield* databaseTime
          const id = `v1.${now - 58_500}.${now + 1_500}.0c2f3a55-5b8e-4d53-9a51-1f7b3d9f0c11`

          // The first attempt stops inside its transaction, before commit.
          const committing = yield* test.pauseNext("beforeCommit")
          const first = yield* journal.Add(1).pipe(Actor.commandId(id), Effect.forkChild)
          yield* committing.reached

          // The retry finds no receipt yet, passes its expiry check, and waits to be delivered.
          const delivering = yield* test.pauseNext("beforeDelivery")

          const retry = yield* journal
            .Add(1)
            .pipe(Actor.commandId(id), Effect.flip, Effect.forkChild)

          yield* delivering.reached

          yield* committing.release
          expect(yield* Fiber.join(first)).toBe(1)

          // The id expires and its receipt passes keepReceipts before the retry's turn.
          yield* test.advance("3 days")
          yield* test.cleanup
          expect(yield* test.inspect(journal.ref)).toMatchObject({ receipts: 0 })

          yield* delivering.release
          const failure = yield* Fiber.join(retry)
          expect(Schema.is(ActorError)(failure) && failure.reason).toBeInstanceOf(CommandExpired)
          expect(fixture.retention.adds - before).toBe(1)
          expect(yield* journal.Total()).toBe(1)
        }),
      ),
  },
  {
    name: "cancels a query read past commandTimeout on the server",
    requiresIndependentConnections: true,
    timeoutMs: 20_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const journal = yield* Journal.get("slow-read")
          yield* journal.Add(1)
          const connect = environment.connect!
          const locker = yield* connect

          // An exclusive lock blocks the query's state read until the lock goes.
          yield* locker.query("BEGIN")
          yield* locker.query("LOCK TABLE actor_state IN ACCESS EXCLUSIVE MODE")

          const started = yield* Clock.currentTimeMillis
          const failure = yield* journal.Total().pipe(Effect.flip)
          expect(failure.reason).toBeInstanceOf(Timeout)
          expect((yield* Clock.currentTimeMillis) - started < 10_000).toBe(true)

          // The runtime cancelled its statement rather than leaving it queued on the lock.
          const waiting = yield* locker.query(
            `SELECT count(*)::int AS waiting FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
          )

          expect(waiting).toEqual([{ waiting: 0 }])
          yield* locker.query("ROLLBACK")
          expect(yield* journal.Total()).toBe(1)
        }),
      ),
  },
]
