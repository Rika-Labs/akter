import { DateTime, Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Actors, RetentionGap, System, UnknownCursor } from "../../index.ts"
import { Request } from "../../runtime/request.ts"
import { appendEvents } from "../../runtime/events/append.ts"
import { routingKey } from "../../runtime/storage/codec.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase } from "../conformance.ts"

export interface EventsFixture {
  escaped: Effect.Effect<void>
  duringQuery: Effect.Effect<void>
}

export const eventsFixture = (): EventsFixture => ({
  escaped: Effect.void,
  duringQuery: Effect.void,
})

class Posted extends Actor.Event<Posted>()("Posted", { body: Schema.String }) {}

class Archived extends Actor.Event<Archived>()("Archived", {}) {}

class Stray extends Actor.Event<Stray>()("Posted", { body: Schema.Finite }) {}

class Closed extends Schema.TaggedError<Closed>()("Closed", {}) {}

const Post = Actor.command("Post", { input: Schema.String, output: Schema.String })

const Archive = Actor.command("Archive")

const PostThenFail = Actor.command("PostThenFail", { input: Schema.String, errors: [Closed] })

const PostThenDie = Actor.command("PostThenDie", { input: Schema.String })

const PostCaught = Actor.command("PostCaught", { input: Schema.String })

const Leak = Actor.command("Leak")

const UseLeak = Actor.command("UseLeak")

const EmitUndeclared = Actor.command("EmitUndeclared")

const Entry = Schema.Struct({
  cursor: Schema.String,
  event: Schema.Union([Posted, Archived]),
  commandId: Schema.String,
  timestamp: Schema.DateTimeUtc,
})

const History = Actor.query("History", {
  input: Schema.Struct({
    after: Schema.optional(Schema.String),
    archived: Schema.optional(Schema.Boolean),
  }),
  output: Schema.Array(Entry),
  errors: [UnknownCursor, RetentionGap],
})

const Snapshot = Actor.query("Snapshot", {
  output: Schema.Struct({
    cursor: Schema.String,
    first: Schema.Array(Schema.String),
    second: Schema.Array(Schema.String),
  }),
  errors: [UnknownCursor, RetentionGap],
})

/** @internal */
export const Feed = Actor.make("Feed", {
  key: Schema.String,
  events: [Posted, Archived],
  api: {
    Post,
    Archive,
    PostThenFail,
    PostThenDie,
    PostCaught,
    Leak,
    UseLeak,
    EmitUndeclared,
    History,
    Snapshot,
  },
})

export const eventsLayer = (fixture: EventsFixture) =>
  Feed.toLayer(
    Effect.succeed({
      Post: Effect.fnUntraced(function* (body: string) {
        const turn = yield* Feed.Turn
        yield* turn.emit(Posted.make({ body }))

        return turn.commandId
      }),
      Archive: Effect.fnUntraced(function* () {
        yield* (yield* Feed.Turn).emit(Archived.make({}))
      }),
      PostThenFail: Effect.fnUntraced(function* (body: string) {
        yield* (yield* Feed.Turn).emit(Posted.make({ body }))

        return yield* Closed.make({})
      }),
      PostThenDie: Effect.fnUntraced(function* (body: string) {
        yield* (yield* Feed.Turn).emit(Posted.make({ body }))

        return yield* Effect.die(new Error("handler defect after emit"))
      }),
      PostCaught: Effect.fnUntraced(function* (body: string) {
        const turn = yield* Feed.Turn
        yield* turn.emit(Posted.make({ body }))
        yield* Effect.fail(Closed.make({})).pipe(Effect.ignore)
      }),
      Leak: Effect.fnUntraced(function* () {
        fixture.escaped = (yield* Feed.Turn).emit(Posted.make({ body: "leaked" }))
      }),
      UseLeak: () => Effect.suspend(() => fixture.escaped),
      EmitUndeclared: Effect.fnUntraced(function* () {
        const turn = yield* Feed.Turn
        // @ts-expect-error the type already rejects it; the runtime must reject it too
        yield* turn.emit(Stray.make({ body: 1 }))
      }),
    }),
  )

export const eventsQueryLayer = (fixture: EventsFixture) =>
  Feed.toQueryLayer(
    Effect.succeed({
      Snapshot: Effect.fnUntraced(function* () {
        const read = yield* Feed.Read
        const first = yield* read.events(Posted)
        yield* fixture.duringQuery
        const second = yield* read.events(Posted)

        return {
          cursor: read.cursor,
          first: first.map(({ event }) => event.body),
          second: second.map(({ event }) => event.body),
        }
      }),
      History: Effect.fnUntraced(function* ({ after, archived }) {
        const read = yield* Feed.Read

        return archived === true
          ? yield* read.events(Archived, { after })
          : yield* read.events(Posted, { after })
      }),
    }),
  )

const PostedJson = Schema.fromJsonString(Schema.toCodecJson(Posted))

export const bodies = (entries: ReadonlyArray<typeof Entry.Type>) =>
  entries.map(({ event }) => (Schema.is(Posted)(event) ? event.body : event._tag))

export const cursors = (entries: ReadonlyArray<typeof Entry.Type>) =>
  entries.map(({ cursor }) => cursor)

/** Deletes the oldest events up to `through`, as retention will. */
export const prune = Effect.fnUntraced(function* (id: string, through: number) {
  const sql = yield* SqlClient.SqlClient
  const test = yield* ActorTest
  yield* sql`DELETE FROM actor_events
    WHERE tenant_id = ${test.tenant} AND actor_type = 'Feed' AND actor_id = ${id} AND sequence <= ${through}`
}, Effect.orDie)

/** Event cases: events append only on commit, replay in order after an exclusive cursor, and are discarded on declared failures and defects. */
export const eventsConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "appends events only on commit and replays one class in order after an exclusive cursor",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const feed = yield* Feed.get("ordered")
          const other = yield* Feed.get("ordered-other")
          const start = yield* DateTime.now
          expect(yield* feed.History({})).toEqual([])
          const first = yield* feed.Post("a")
          yield* feed.Archive()
          const third = yield* feed.Post("b")
          yield* feed.Post("c")
          yield* other.Post("elsewhere")

          const all = yield* feed.History({})
          expect(bodies(all)).toEqual(["a", "b", "c"])
          expect(cursors(all)).toEqual(["1", "3", "4"])
          expect(all[0]!.commandId).toBe(first)
          expect(all[1]!.commandId).toBe(third)
          expect(all[0]!.event).toBeInstanceOf(Posted)

          for (const entry of all)
            expect(
              Math.abs(DateTime.toEpochMillis(entry.timestamp) - DateTime.toEpochMillis(start)) <
                60_000,
            ).toBe(true)

          expect(cursors(yield* feed.History({ archived: true }))).toEqual(["2"])
          expect(bodies(yield* feed.History({ after: "1" }))).toEqual(["b", "c"])
          expect(bodies(yield* feed.History({ after: "3" }))).toEqual(["c"])
          expect(yield* feed.History({ after: "4" })).toEqual([])
          expect(bodies(yield* other.History({}))).toEqual(["elsewhere"])
          expect(yield* test.inspect(feed.ref)).toMatchObject({ receipts: 4, events: 4 })

          expect(yield* feed.Post("a").pipe(Actor.commandId(first))).toBe(first)
          expect(yield* test.inspect(feed.ref)).toMatchObject({ receipts: 4, events: 4 })
        }),
      ),
  },
  {
    name: "discards events on declared failure and defect but commits them after a caught error",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const feed = yield* Feed.get("rollback")
          yield* feed.Post("kept")

          const failed = yield* (yield* Actors).mintCommandId
          expect(
            yield* feed.PostThenFail("failed").pipe(Actor.commandId(failed), Effect.flip),
          ).toEqual(Closed.make({}))
          expect(yield* test.inspect(feed.ref)).toMatchObject({ receipts: 2, events: 1 })
          expect(
            yield* feed.PostThenFail("failed").pipe(Actor.commandId(failed), Effect.flip),
          ).toEqual(Closed.make({}))
          expect(yield* test.inspect(feed.ref)).toMatchObject({ receipts: 2, events: 1 })

          const defect = yield* feed.PostThenDie("defect").pipe(Effect.exit)
          expect(Exit.isFailure(defect)).toBe(true)
          expect(yield* test.inspect(feed.ref)).toMatchObject({ receipts: 2, events: 1 })

          yield* feed.PostCaught("caught")
          expect(yield* test.inspect(feed.ref)).toMatchObject({ receipts: 3, events: 2 })
          expect(bodies(yield* feed.History({}))).toEqual(["kept", "caught"])
          expect(cursors(yield* feed.History({}))).toEqual(["1", "2"])
        }),
      ),
  },
  ...(["beforeHandler", "beforeCommit", "afterCommit"] as const).map((point): ConformanceCase => ({
    name: `appends one event per command and none for a declared failure across ${point} crashes`,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const feed = yield* Feed.get(`crash-${point}`)
          yield* feed.Post("before")
          yield* test.crashNext(point)
          const commandId = yield* feed.Post("crashed")
          yield* feed.Post("after")
          const history = yield* feed.History({})
          expect(bodies(history)).toEqual(["before", "crashed", "after"])
          expect(cursors(history)).toEqual(["1", "2", "3"])
          expect(history[1]!.commandId).toBe(commandId)
          expect(yield* test.inspect(feed.ref)).toMatchObject({ receipts: 3, events: 3 })
          yield* test.crashNext(point)
          expect(yield* feed.PostThenFail("failed").pipe(Effect.flip)).toEqual(Closed.make({}))
          expect(yield* test.inspect(feed.ref)).toMatchObject({ receipts: 4, events: 3 })
        }),
      ),
  })),
  {
    name: "rejects escaped and undeclared emits without committing events",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const feed = yield* Feed.get("escaped")
          yield* feed.Leak()
          expect(Exit.isFailure(yield* feed.UseLeak().pipe(Effect.exit))).toBe(true)
          expect(Exit.isFailure(yield* feed.EmitUndeclared().pipe(Effect.exit))).toBe(true)
          expect(yield* test.inspect(feed.ref)).toMatchObject({ receipts: 1, events: 0 })
        }),
      ),
  },
  {
    name: "rejects unknown cursors and reports pruned history as an explicit retention gap",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const feed = yield* Feed.get("pruned")
          const fresh = yield* Feed.get("pruned-fresh")

          for (const cursor of ["x", "-1", "01", "1.0", " 1", "9223372036854775808"])
            expect(yield* feed.History({ after: cursor }).pipe(Effect.flip)).toEqual(
              UnknownCursor.make({ cursor }),
            )

          expect(yield* fresh.History({ after: "1" }).pipe(Effect.flip)).toEqual(
            UnknownCursor.make({ cursor: "1" }),
          )

          for (const body of ["a", "b", "c", "d"]) yield* feed.Post(body)
          expect(yield* feed.History({ after: "5" }).pipe(Effect.flip)).toEqual(
            UnknownCursor.make({ cursor: "5" }),
          )

          yield* prune("pruned", 2)
          expect(yield* test.inspect(feed.ref)).toMatchObject({ events: 2 })

          expect(yield* feed.History({}).pipe(Effect.flip)).toEqual(
            RetentionGap.make({ cursor: "0" }),
          )
          expect(yield* feed.History({ after: "1" }).pipe(Effect.flip)).toEqual(
            RetentionGap.make({ cursor: "1" }),
          )
          expect(yield* feed.History({ after: "1", archived: true }).pipe(Effect.flip)).toEqual(
            RetentionGap.make({ cursor: "1" }),
          )
          expect(bodies(yield* feed.History({ after: "2" }))).toEqual(["c", "d"])

          yield* prune("pruned", 4)
          expect(yield* feed.History({ after: "3" }).pipe(Effect.flip)).toEqual(
            RetentionGap.make({ cursor: "3" }),
          )
          expect(yield* feed.History({ after: "4" })).toEqual([])

          yield* feed.Post("e")
          expect(cursors(yield* feed.History({ after: "4" }))).toEqual(["5"])
        }),
      ),
  },
  {
    name: "bounds every replay in a query to the snapshot its state was read at",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const feed = yield* Feed.get("snapshot")
          yield* feed.Post("a")
          yield* feed.Post("b")
          const reached = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          fixture.events.duringQuery = Deferred.succeed(reached, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          )
          const reader = yield* feed.Snapshot().pipe(Effect.forkChild)
          yield* Deferred.await(reached)
          fixture.events.duringQuery = Effect.void
          yield* feed.Post("c")
          yield* Deferred.succeed(release, undefined)
          expect(yield* Fiber.join(reader)).toEqual({
            cursor: "2",
            first: ["a", "b"],
            second: ["a", "b"],
          })
          expect(bodies(yield* feed.History({ after: "2" }))).toEqual(["c"])
          expect((yield* feed.Snapshot()).cursor).toBe("3")
        }),
      ),
  },
  {
    name: "hides a running turn's uncommitted events from replay",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const feed = yield* Feed.get("uncommitted")
          yield* feed.Post("committed")
          const pause = yield* test.pauseNext("beforeCommit")
          const writer = yield* feed.Post("pending").pipe(Effect.forkChild)
          yield* pause.reached
          expect(bodies(yield* feed.History({}))).toEqual(["committed"])
          expect(yield* feed.History({ after: "2" }).pipe(Effect.flip)).toEqual(
            UnknownCursor.make({ cursor: "2" }),
          )
          yield* pause.release
          yield* Fiber.join(writer)
          expect(bodies(yield* feed.History({}))).toEqual(["committed", "pending"])
        }),
      ),
  },
  {
    name: "orders events gap-free when a rival activation races the owner for one actor",
    requiresIndependentConnections: true,
    timeoutMs: 30_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const feed = yield* Feed.get("raced")
          yield* feed.Post("seed")
          const key = routingKey({ ref: feed.ref, placement: "tenant" })
          const { tenant, actor, id } = feed.ref

          const rival = (index: number) =>
            sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql`SELECT generation FROM actor_generations
                    WHERE routing_key = ${key} AND tenant_id = ${tenant} AND actor_type = ${actor} AND actor_id = ${id}
                    FOR UPDATE`
                  yield* sql`UPDATE actor_generations SET generation = generation + 1
                    WHERE routing_key = ${key} AND tenant_id = ${tenant} AND actor_type = ${actor} AND actor_id = ${id}`
                  yield* appendEvents(
                    Request.make({
                      ref: feed.ref,
                      caller: System.make({ source: "actor" }),
                      command: "Post",
                      commandId: `rival-${index}`,
                      payload: "null",
                    }),
                    key,
                    [
                      {
                        tag: "Posted",
                        value: yield* Schema.encodeEffect(PostedJson)(
                          Posted.make({ body: `rival-${index}` }),
                        ),
                        version: 0,
                      },
                    ],
                  )
                }),
              )
              .pipe(Effect.orDie)

          const pause = yield* test.pauseNext("beforeHandler")
          const held = yield* feed.Post("held").pipe(Effect.forkChild)
          yield* pause.reached
          const blocked = yield* rival(0).pipe(Effect.forkChild)
          yield* pause.release
          const first = yield* Fiber.join(held)
          yield* Fiber.join(blocked)

          const [owned] = yield* Effect.all(
            [
              Effect.forEach(
                Array.from({ length: 11 }, (_, index) => `owner-${index}`),
                (body) => feed.Post(body),
                { concurrency: "unbounded" },
              ),
              Effect.forEach(
                Array.from({ length: 11 }, (_, index) => index + 1),
                rival,
                {
                  concurrency: 4,
                },
              ),
            ],
            { concurrency: 2 },
          )

          const history = yield* feed.History({})
          expect(cursors(history)).toEqual(
            Array.from({ length: 25 }, (_, index) => String(index + 1)),
          )
          expect(new Set(history.map(({ commandId }) => commandId)).size).toBe(25)
          expect(bodies(history).slice(0, 3)).toEqual(["seed", "held", "rival-0"])
          expect(
            [first, ...owned].every((commandId) =>
              history.some((entry) => entry.commandId === commandId),
            ),
          ).toBe(true)
          const inspection = yield* test.inspect(feed.ref)
          expect(inspection).toMatchObject({ receipts: 13, events: 25 })
          expect(Number(inspection.generation) >= 14).toBe(true)
        }),
      ),
  },
]
