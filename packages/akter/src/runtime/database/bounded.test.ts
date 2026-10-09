import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import {
  Cause,
  Config,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Queue,
  Redacted,
  Schedule,
  Scope,
  Schema,
  Stream,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { SqlClient, SqlError } from "effect/sql"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { Reactivity } from "effect/reactivity"
import { boundedLayer, boundedPool, isPoolRefusal, POOL_WAITERS } from "./bounded.ts"
import { TurnConnections, turnConnections } from "../turn/pipeline.ts"
import { Coordination, coordinationLayer } from "./coordination.ts"
import { QueryPool, ReadReplica } from "./replica.ts"
import { Database } from "../layer.ts"
import { Actor, Actors as ActorClient, Intent, User } from "../../index.ts"
import { Actors, Auth, Inspector } from "../index.ts"
import { ActorTest } from "../../testing/actor-test.ts"
import { disposableDatabase } from "../../testing/database.ts"

/**
 * Runs `callers` loops of `step` for `durationMs` and counts each loop's
 * completed steps. A pool that lets the fiber freeing a connection take it
 * again leaves every caller beyond the pool's size at zero.
 */
const contend = <E>(callers: number, durationMs: number, step: Effect.Effect<unknown, E>) =>
  Effect.gen(function* () {
    const counts = Array.from({ length: callers }, () => 0)
    const deadline = performance.now() + durationMs

    yield* Effect.forEach(
      counts,
      (_, caller) =>
        Effect.gen(function* () {
          while (performance.now() < deadline) {
            yield* step
            counts[caller]! += 1
          }
        }),
      { concurrency: "unbounded", discard: true },
    )

    return counts
  })

describe("first-come, first-served pools with Postgres", () => {
  const runtime = ManagedRuntime.make(Layer.empty)
  afterAll(() => runtime.dispose())

  it("keeps every caller moving on each runtime pool when callers outnumber connections", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* Config.Redacted("TEST_DATABASE_URL")
          const context = yield* Layer.build(
            Database.postgres({
              url,
              maxConnections: 2,
              offTurnConnections: 2,
              queryConnections: 2,
              replica: { url, maxConnections: 2 },
              coordination: { url, maxConnections: 2 },
            }),
          )
          const offTurn = Context.get(context, SqlClient.SqlClient)
          const queries = Context.get(context, QueryPool)!
          const replica = Context.get(context, ReadReplica)!
          const coordination = Context.get(context, Coordination)!
          const turns = Context.get(context, TurnConnections)

          const counts = yield* Effect.all(
            [
              contend(24, 1500, offTurn`SELECT 1`),
              contend(24, 1500, queries`SELECT 1`),
              contend(24, 1500, replica`SELECT 1`),
              contend(24, 1500, coordination`SELECT 1`),
              contend(
                24,
                1500,
                Effect.scoped(
                  Effect.flatMap(turns.lease, (connection) => connection.query("SELECT 1")),
                ),
              ),
            ],
            { concurrency: "unbounded" },
          )

          for (const pool of counts) expect(Math.min(...pool)).toBeGreaterThan(10)
        }),
      ),
    ))

  it("fails a COMMIT that Postgres answers with ROLLBACK, as a Postgres client does", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* Config.Redacted("TEST_DATABASE_URL")
          const sql = Context.get(
            yield* Layer.build(boundedLayer({ url, maxConnections: 2 })),
            SqlClient.SqlClient,
          )

          const exit = yield* sql
            .withTransaction(sql`SELECT 1 / 0`.pipe(Effect.ignore))
            .pipe(Effect.exit)
          const aborted = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

          expect(SqlError.isSqlError(aborted) && aborted.reason._tag).toBe("UnknownError")
          expect(yield* sql<{ one: number }>`SELECT 1 AS one`).toEqual([{ one: 1 }])
        }),
      ),
    ))

  it("refuses past the checkout bound at once and serves admitted waiters in arrival order, after many checkouts returned", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* Config.Redacted("TEST_DATABASE_URL")
          const sql = Context.get(
            yield* Layer.build(boundedLayer({ url, maxConnections: 1 })),
            SqlClient.SqlClient,
          )
          for (let round = 0; round < 3 * POOL_WAITERS; round++) {
            yield* sql`SELECT ${round}::int AS round`
            yield* sql.withTransaction(sql`SELECT ${round}::int AS round`)
            yield* Effect.scoped(sql.reserve)
          }

          const held = yield* Scope.fork(yield* Effect.scope)
          yield* sql.reserve.pipe(Scope.provide(held))
          const served: Array<number> = []
          const waiting = yield* Effect.forEach(
            Array.from({ length: POOL_WAITERS }, (_, index) => index),
            (index) =>
              sql<{ value: number }>`SELECT ${index}::int AS value`.pipe(
                Effect.tap(([row]) =>
                  Effect.sync(() => {
                    served.push(row!.value)
                  }),
                ),
                Effect.forkScoped,
              ),
          )
          yield* Effect.sleep("50 millis")
          expect(waiting.every((fiber) => fiber.pollUnsafe() === undefined)).toBe(true)

          const refused = yield* sql`SELECT 1`.pipe(Effect.timeout("1 second"), Effect.exit)
          const error = Exit.isFailure(refused) ? Cause.squash(refused.cause) : undefined
          expect(isPoolRefusal(error)).toBe(true)

          yield* Scope.close(held, Exit.void)
          yield* Fiber.joinAll(waiting)
          expect(served).toEqual(Array.from({ length: POOL_WAITERS }, (_, index) => index))
          expect(yield* sql<{ value: number }>`SELECT 7 AS value`).toEqual([{ value: 7 }])
        }),
      ),
    ))

  it("isolates nested failures, releases savepoints, and commits only the surviving writes", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* Config.Redacted("TEST_DATABASE_URL")
          const sql = Context.get(
            yield* Layer.build(boundedLayer({ url, maxConnections: 1 })),
            SqlClient.SqlClient,
          )
          yield* sql`CREATE TEMP TABLE checkout_savepoints (value integer)`
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO checkout_savepoints VALUES (11)`
              const failure = yield* sql
                .withTransaction(
                  sql`INSERT INTO checkout_savepoints VALUES (17)`.pipe(
                    Effect.andThen(sql`SELECT 1 / 0`),
                  ),
                )
                .pipe(Effect.exit)
              expect(Exit.isFailure(failure)).toBe(true)
              yield* sql.withTransaction(sql`INSERT INTO checkout_savepoints VALUES (23)`)
              yield* sql`INSERT INTO checkout_savepoints VALUES (31)`
            }),
          )
          expect(yield* sql`SELECT value FROM checkout_savepoints ORDER BY value`).toEqual([
            { value: 11 },
            { value: 23 },
            { value: 31 },
          ])

          for (const failed of [false, true]) {
            const exit = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql
                    .withTransaction(failed ? Effect.fail("nested failure") : Effect.void)
                    .pipe(Effect.ignore)
                  yield* sql.unsafe("RELEASE SAVEPOINT effect_sql_1")
                }),
              )
              .pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
            expect(SqlError.isSqlError(error) && error.reason.cause).toMatchObject({
              code: "3B001",
            })
          }
          expect(yield* sql`SELECT count(*)::int AS count FROM checkout_savepoints`).toEqual([
            { count: 3 },
          ])
        }),
      ),
    ))

  it.each([false, true])(
    "cancels an interrupted statement and returns a clean single-connection pool (transaction: %s)",
    (transaction) =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const url = yield* Config.Redacted("TEST_DATABASE_URL")
            const applicationName = `checkout-interrupt-${transaction}`
            const connectionString = yield* Config.String("TEST_DATABASE_URL")
            const sql = Context.get(
              yield* Layer.build(boundedLayer({ url, maxConnections: 1, applicationName })),
              SqlClient.SqlClient,
            )
            const observer = yield* Effect.acquireRelease(
              Effect.sync(() => new Pool({ connectionString, max: 1 })),
              (pool) => Effect.promise(() => pool.end()),
            )
            yield* sql`CREATE TEMP TABLE checkout_interrupt (value integer)`
            const statement = transaction
              ? sql.withTransaction(
                  sql`INSERT INTO checkout_interrupt VALUES (47)`.pipe(
                    Effect.andThen(sql`SELECT pg_sleep(60)`),
                  ),
                )
              : sql`SELECT pg_sleep(60)`
            const running = yield* Effect.forkChild(statement)
            yield* Effect.promise(() =>
              observer.query(
                "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND state = 'active' AND wait_event = 'PgSleep'",
                [applicationName],
              ),
            ).pipe(
              Effect.flatMap((result) =>
                result.rowCount === 1 ? Effect.void : Effect.fail("not sleeping"),
              ),
              Effect.retry({ times: 200, schedule: Schedule.spaced("10 millis") }),
            )

            yield* Fiber.interrupt(running).pipe(Effect.timeout("10 seconds"))
            const exit = yield* Fiber.await(running)
            expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
            expect(
              yield* sql`SELECT value FROM checkout_interrupt`.pipe(Effect.timeout("2 seconds")),
            ).toEqual([])
            yield* sql.withTransaction(sql`INSERT INTO checkout_interrupt VALUES (59)`)
            expect(yield* sql`SELECT value FROM checkout_interrupt`).toEqual([{ value: 59 }])
            const sleeping = yield* Effect.promise(() =>
              observer.query(
                "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND state = 'active' AND wait_event = 'PgSleep'",
                [applicationName],
              ),
            )
            expect(sleeping.rowCount).toBe(0)
          }),
        ),
      ),
  )

  it("notifies outside the current transaction and rejects channels exceeding 63 UTF-8 bytes", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* Config.Redacted("TEST_DATABASE_URL")
          const client = Context.get(
            yield* Layer.build(boundedLayer({ url, maxConnections: 2 })),
            PgClient.PgClient,
          )
          const listener = Context.get(
            yield* Layer.build(boundedLayer({ url, maxConnections: 1 })),
            PgClient.PgClient,
          )
          const channel = "checkout-notify"
          const notifications = yield* listener.listen(channel)
          const exit = yield* client
            .withTransaction(
              Effect.gen(function* () {
                yield* client.notify(channel, "outside")
                expect(
                  yield* Queue.take(notifications).pipe(Effect.timeout("2 seconds")),
                ).toMatchObject({
                  channel,
                  payload: "outside",
                })
                return yield* Effect.fail("rollback")
              }),
            )
            .pipe(Effect.exit)
          expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe("rollback")
          const invalid = yield* client.notify("é".repeat(32), "rejected").pipe(Effect.exit)
          const error = Exit.isFailure(invalid) ? Cause.squash(invalid.cause) : undefined
          expect(SqlError.isSqlError(error) && error.reason._tag).toBe("UnknownError")
          yield* client.notify(`${"é".repeat(31)}x`, "accepted")
        }),
      ),
    ))
})

describe("bounded Postgres checkout queues", () => {
  const runtime = ManagedRuntime.make(Layer.merge(Reactivity.layer, BunCrypto.layer))
  afterAll(() => runtime.dispose())
  it("retries checkout refusals while concurrently registering actor and query layers", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const database = yield* disposableDatabase({
            url: Redacted.make(yield* Config.String("TEST_DATABASE_URL")),
          })
          const Ping = Actor.command("Ping", { payload: Schema.Int, success: Schema.Int })
          const Value = Actor.query("Value", { success: Schema.Int })
          const actors = Array.from({ length: 80 }, (_, index) =>
            Actor.make(`StartupPool${index}`, {
              key: Schema.String,
              state: Actor.state({}),
              api: { Ping, Value },
            }),
          )
          const layers = actors.flatMap((actor) => [
            actor.toLayer(Effect.succeed({ Ping: (value: number) => Effect.succeed(value) })),
            actor.toQueryLayer(Effect.succeed({ Value: () => Effect.succeed(37) })),
          ])
          const live = yield* Effect.acquireRelease(
            Effect.sync(() =>
              ManagedRuntime.make(
                Layer.mergeAll(Layer.empty, ...layers).pipe(
                  Layer.provideMerge(ActorTest.layer({ database, maxConnections: 2 })),
                  Layer.provide(BunCrypto.layer),
                ),
              ),
            ),
            (live) => Effect.promise(() => live.dispose()),
          )
          yield* Effect.promise(() =>
            live.runPromise(
              Effect.gen(function* () {
                const test = yield* ActorTest
                for (const [index, actor] of actors.entries()) {
                  const handle = yield* actor.get("probe")
                  expect(yield* handle.Ping(index + 11)).toBe(index + 11)
                  expect(yield* handle.Value()).toBe(37)
                  expect(yield* test.inspect(handle.ref)).toMatchObject({ receipts: 1 })
                }
              }),
            ),
          )
        }),
      ),
    ))
  it("uses one connection for nested transactions and streaming reads without checking out again", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = Redacted.make(yield* Config.String("TEST_DATABASE_URL"))
          const sql = yield* boundedPool({ url, maxConnections: 1 })
          expect(
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const first = yield* sql<{ value: number }>`SELECT 13 AS value`
                const nested = yield* sql.withTransaction(
                  sql<{ value: number }>`SELECT 31 AS value`,
                )
                const streamed = yield* Stream.runCollect(
                  sql<{ value: number }>`SELECT 47 AS value`.stream,
                )
                return [first, nested, streamed]
              }),
            ),
          ).toEqual([[{ value: 13 }], [{ value: 31 }], [{ value: 47 }]])
          expect(
            yield* Stream.runCollect(sql<{ value: number }>`SELECT 59 AS value`.stream),
          ).toEqual([{ value: 59 }])
          expect(yield* sql`SELECT 71 AS value`).toEqual([{ value: 71 }])
        }),
      ),
    ))
  it.each(["off-turn", "coordination"] as const)(
    "refuses an excess %s statement before sending it and recovers every checkout after cancellation",
    (kind) =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const url = Redacted.make(yield* Config.String("TEST_DATABASE_URL"))
            const sql =
              kind === "off-turn"
                ? yield* boundedPool({ url, maxConnections: 1 })
                : Context.get(
                    yield* Layer.build(coordinationLayer({ url, maxConnections: 1 })),
                    Coordination,
                  )!
            yield* sql`CREATE TEMP TABLE load_shedding_probe (value integer)`
            const held = yield* Scope.fork(yield* Effect.scope)
            yield* sql.reserve.pipe(Scope.provide(held))
            const queued = yield* Effect.forEach(Array.from({ length: 64 }), () =>
              sql`SELECT 1`.pipe(Effect.forkScoped),
            )
            yield* Effect.sleep("50 millis")
            expect(queued.every((fiber) => fiber.pollUnsafe() === undefined)).toBe(true)
            const refused = yield* sql`INSERT INTO load_shedding_probe VALUES (17)`.pipe(
              Effect.exit,
            )
            expect(Exit.isFailure(refused)).toBe(true)
            expect(Exit.findErrorOption(refused)).toMatchObject({ value: { isRetryable: true } })
            for (const fiber of queued) yield* Fiber.interrupt(fiber)
            yield* Scope.close(held, Exit.void)
            expect(yield* sql`SELECT * FROM load_shedding_probe`).toEqual([])
            yield* sql`INSERT INTO load_shedding_probe VALUES (23)`
            expect(yield* sql`SELECT * FROM load_shedding_probe`).toEqual([{ value: 23 }])
          }),
        ),
      ),
  )

  it("bounds turn-session waiters independently of HTTP and releases cancelled leases", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = Redacted.make(yield* Config.String("TEST_DATABASE_URL"))
          const context = yield* Layer.build(turnConnections({ url, maxConnections: 1 }))
          const turns = Context.get(context, TurnConnections)
          const held = yield* Scope.fork(yield* Effect.scope)
          yield* turns.lease.pipe(Scope.provide(held))
          const release = yield* Deferred.make<void>()
          const queued = yield* Effect.forEach(Array.from({ length: 64 }), () =>
            Effect.scoped(Effect.andThen(turns.lease, Deferred.await(release))).pipe(
              Effect.forkScoped,
            ),
          )
          yield* Effect.sleep("10 millis").pipe(
            Effect.repeat({
              until: () => turns.sessions().waiting === 64,
            }),
          )
          const refused = yield* Effect.scoped(turns.lease).pipe(Effect.exit)
          const error = Exit.findErrorOption(refused)
          expect(error).toMatchObject({ value: { isRetryable: true } })
          expect(isPoolRefusal(Option.getOrThrow(error))).toBe(true)
          expect(turns.sessions()).toEqual({ leased: 1, waiting: 64 })
          for (const fiber of queued) yield* Fiber.interrupt(fiber)
          yield* Scope.close(held, Exit.void)
          expect(turns.sessions()).toEqual({ leased: 0, waiting: 0 })
          expect(
            yield* Effect.scoped(
              turns.lease.pipe(
                Effect.flatMap((connection) => connection.queryValues("SELECT 29", [])),
              ),
            ),
          ).toEqual([[29]])
        }),
      ),
    ))
})

describe("low-connection Postgres preset", () => {
  const runtime = ManagedRuntime.make(BunCrypto.layer)
  afterAll(() => runtime.dispose())

  it.each([undefined, 2])(
    "caps saturated sessions, preserves explicit turn sizing (%s), and releases interrupted waiters",
    (maxConnections) =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const url = yield* disposableDatabase({
              url: yield* Config.Redacted("TEST_DATABASE_URL"),
            })
            const applicationName = "low-connection-budget"
            const context = yield* Layer.build(
              Actors.layer().pipe(
                Layer.provideMerge(
                  Database.postgres({
                    url,
                    preset: "low-connection",
                    applicationName,
                    maxConnections,
                  }),
                ),
              ),
            )
            const observer = yield* Effect.acquireRelease(
              Effect.sync(() => new Pool({ connectionString: Redacted.value(url), max: 1 })),
              (pool) => Effect.promise(() => pool.end()),
            )
            const sql = Context.get(context, SqlClient.SqlClient)
            const queries = Context.get(context, QueryPool)!
            const turns = Context.get(context, TurnConnections)
            const held = yield* Scope.fork(yield* Effect.scope)
            yield* sql.reserve.pipe(Scope.provide(held))
            yield* queries.reserve.pipe(Scope.provide(held))
            for (let index = 0; index < (maxConnections ?? 1); index++)
              yield* turns.lease.pipe(Scope.provide(held))

            const sessions = yield* Effect.promise(() =>
              observer.query(
                "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = $1 AND datname = current_database()",
                [applicationName],
              ),
            )
            expect(sessions.rows).toEqual([{ count: 3 + (maxConnections ?? 1) }])

            const waiting = yield* Effect.forEach(
              [sql`SELECT 13 AS value`, queries`SELECT 31 AS value`, Effect.scoped(turns.lease)],
              (work) => Effect.forkScoped(work),
            )
            yield* Effect.sleep("50 millis")
            expect(waiting.every((fiber) => fiber.pollUnsafe() === undefined)).toBe(true)
            for (const fiber of waiting) yield* Fiber.interrupt(fiber)
            yield* Scope.close(held, Exit.void)

            expect(
              yield* sql.withTransaction(sql.withTransaction(sql`SELECT 13 AS value`)),
            ).toEqual([{ value: 13 }])
            expect(yield* queries`SELECT 31 AS value`).toEqual([{ value: 31 }])
            expect(
              yield* Effect.scoped(
                Effect.flatMap(turns.lease, (connection) => connection.queryValues("SELECT 47")),
              ),
            ).toEqual([[47]])
          }).pipe(Effect.timeout("10 seconds")),
        ),
      ),
  )

  it("releases a turn while a capped job claim holds the spare off-turn session waiting for that turn's generation lock", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* disposableDatabase({
            url: yield* Config.Redacted("TEST_DATABASE_URL"),
          })
          const held = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const Start = Actor.command("Start")
          const Hold = Actor.command("Hold")
          const Done = Actor.command("Done", { payload: Schema.Int })
          const Value = Actor.query("Value", { success: Schema.Int })
          const Job = Actor.job("CappedPoolJob", { success: Schema.Int })
          const Probe = Actor.make("CappedPoolProbe", {
            key: Schema.String,
            state: Actor.state({
              total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
            }),
            api: { Start, Hold, Value },
            internal: { Done },
            jobs: { CappedPoolJob: { job: Job, concurrency: { perActor: 1 }, onSuccess: Done } },
          })
          const context = yield* Layer.build(
            Layer.mergeAll(
              Probe.toLayer(
                Effect.succeed({
                  Start: Effect.fnUntraced(function* () {
                    yield* (yield* Probe.Turn).enqueue(Job.make(), { after: "200 millis" })
                  }),
                  Hold: Effect.fnUntraced(function* () {
                    const turn = yield* Probe.Turn
                    yield* turn.state.set({ total: 13 })
                    yield* Deferred.succeed(held, undefined)
                    yield* Deferred.await(release)
                  }),
                  Done: Effect.fnUntraced(function* (value: number) {
                    const turn = yield* Probe.Turn
                    yield* turn.state.set({ total: turn.state.total + value })
                  }),
                }),
              ),
              Probe.toQueryLayer(
                Effect.succeed({
                  Value: Effect.fnUntraced(function* () {
                    return (yield* Probe.Read).state.total
                  }),
                }),
              ),
              Probe.toJobLayer(Effect.succeed({ CappedPoolJob: () => Effect.succeed(29) })),
            ).pipe(
              Layer.provideMerge(Actors.layer({ relay: { poll: "50 millis" } })),
              Layer.provideMerge(
                Database.postgres({
                  url,
                  preset: "low-connection",
                  applicationName: "low-connection-capped",
                }),
              ),
            ),
          )
          const observer = yield* Effect.acquireRelease(
            Effect.sync(() => new Pool({ connectionString: Redacted.value(url), max: 1 })),
            (pool) => Effect.promise(() => pool.end()),
          )
          const probe = yield* Effect.provide(Probe.get("source"), context)
          yield* Effect.provide(probe.Start(), context)
          const turn = yield* Effect.provide(probe.Hold(), context).pipe(Effect.forkScoped)
          yield* Deferred.await(held)
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
          yield* Effect.promise(() =>
            observer.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'low-connection-capped' AND wait_event_type = 'Lock'",
            ),
          ).pipe(
            Effect.flatMap((rows) =>
              rows.rowCount === 1 ? Effect.void : Effect.fail("not blocked"),
            ),
            Effect.retry({ times: 200, schedule: Schedule.spaced("10 millis") }),
          )
          expect(yield* Effect.provide(probe.Value(), context)).toBe(0)
          const sql = Context.get(context, SqlClient.SqlClient)
          const queued = yield* sql`SELECT 17 AS value`.pipe(Effect.forkScoped)
          yield* Effect.sleep("50 millis")
          expect(queued.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(turn)
          expect(yield* Fiber.join(queued)).toEqual([{ value: 17 }])
          yield* Effect.provide(probe.Value(), context).pipe(
            Effect.flatMap((value) => (value === 42 ? Effect.void : Effect.fail("not settled"))),
            Effect.retry({ times: 200, schedule: Schedule.spaced("10 millis") }),
          )
          expect(
            yield* sql`SELECT command, count(*)::int AS count FROM actor_receipts GROUP BY command ORDER BY command`,
          ).toEqual([
            { command: "Done", count: 1 },
            { command: "Hold", count: 1 },
            { command: "Start", count: 1 },
          ])
          expect(yield* sql`SELECT * FROM actor_outbox`).toEqual([])
        }).pipe(Effect.timeout("10 seconds")),
      ),
    ))

  it("serves reads and inspector snapshots while jobs, relay deliveries and workflow activities wait on the only turn session", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* disposableDatabase({
            url: yield* Config.Redacted("TEST_DATABASE_URL"),
          })
          const holdStarted = yield* Deferred.make<void>()
          const releaseTurn = yield* Deferred.make<void>()
          const jobStarted = yield* Deferred.make<void>()
          const releaseJob = yield* Deferred.make<void>()
          const workflowStarted = yield* Deferred.make<void>()
          const releaseWorkflow = yield* Deferred.make<void>()
          const interruptStarted = yield* Deferred.make<void>()
          const Add = Actor.command("Add", { payload: Schema.Int, success: Schema.Int })
          const Hold = Actor.command("Hold")
          const Stage = Actor.command("Stage")
          const Settle = Actor.command("Settle", { payload: Schema.Int })
          const Value = Actor.query("Value", { success: Schema.Int })
          const Job = Actor.job("PoolJob", { payload: { amount: Schema.Int }, success: Schema.Int })
          const Work = Actor.workflow("Work", {
            payload: { amount: Schema.Int },
            success: Schema.Int,
          })
          const Call = Work.step("call", { payload: Schema.Int, success: Schema.Int })
          const Nap = Work.sleep("nap")
          const Probe = Actor.make("LowConnectionProbe", {
            key: Schema.String,
            state: Actor.state({
              total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
            }),
            api: { Add, Hold, Stage, Value, Work },
            internal: { Settle },
            jobs: { PoolJob: { job: Job, onSuccess: Settle } },
          })
          const app = Layer.mergeAll(
            Probe.toLayer(
              Effect.succeed({
                Add: Effect.fnUntraced(function* (amount: number) {
                  const turn = yield* Probe.Turn
                  yield* turn.state.set({ total: turn.state.total + amount })
                  return turn.state.total
                }),
                Hold: Effect.fnUntraced(function* () {
                  const turn = yield* Probe.Turn
                  yield* turn.state.set({ total: turn.state.total + 101 })
                  yield* Deferred.succeed(holdStarted, undefined)
                  yield* Deferred.await(releaseTurn)
                }),
                Stage: Effect.fnUntraced(function* () {
                  yield* (yield* Probe.Turn).enqueue(Job.make({ amount: 11 }))
                  yield* (yield* Probe.intents("relay")).Add(7).pipe(Intent.after("1 second"))
                }),
                Settle: Effect.fnUntraced(function* (amount: number) {
                  const turn = yield* Probe.Turn
                  yield* turn.state.set({ total: turn.state.total + amount })
                }),
                Work: ({ amount }: { readonly amount: number }) =>
                  Call.run(
                    amount,
                    Effect.fnUntraced(function* (value: number) {
                      if (value < 0) {
                        yield* Deferred.succeed(interruptStarted, undefined)
                        return yield* Effect.never
                      }
                      yield* Deferred.succeed(workflowStarted, undefined)
                      yield* Deferred.await(releaseWorkflow)
                      return yield* (yield* Probe.get("workflow")).Add(value).pipe(Effect.orDie)
                    }),
                  ).pipe(Effect.tap(() => Nap("2 seconds"))),
              }),
            ),
            Probe.toQueryLayer(
              Effect.succeed({
                Value: Effect.fnUntraced(function* () {
                  return (yield* Probe.Read).state.total
                }),
              }),
            ),
            Probe.toJobLayer(
              Effect.succeed({
                PoolJob: Effect.fnUntraced(function* ({ amount }: { readonly amount: number }) {
                  yield* Deferred.succeed(jobStarted, undefined)
                  yield* Deferred.await(releaseJob)
                  return yield* (yield* Probe.get("job")).Add(amount)
                }),
              }),
            ),
          ).pipe(
            Layer.provideMerge(
              Actors.layer({
                authorize: () => Effect.succeed(true),
                relay: { poll: "100 millis" },
                executors: { lease: "3 seconds" },
              }),
            ),
            Layer.provideMerge(
              Database.postgres({
                url,
                preset: "low-connection",
                applicationName: "low-connection-serving",
              }),
            ),
          )
          const appScope = yield* Scope.fork(yield* Effect.scope)
          const context = yield* Layer.build(app).pipe(Scope.provide(appScope))
          const sql = Context.get(context, SqlClient.SqlClient)
          const auth = Auth.make(() =>
            Effect.succeed({ tenant: "default", caller: User.make({ subject: "pool-test" }) }),
          )
          const web = HttpRouter.toWebHandler(
            Layer.merge(Actors.serve({ actors: [Probe], auth }), Inspector.serve({ auth })).pipe(
              Layer.provide(Layer.succeedContext(context)),
            ),
            { disableLogger: true },
          )
          yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                fetch: (request) => web.handler(request),
              }),
            ),
            (server) => Effect.promise(() => server.stop(true)),
          )
          yield* Effect.addFinalizer(() =>
            Effect.all([
              Deferred.succeed(releaseTurn, undefined),
              Deferred.succeed(releaseJob, undefined),
              Deferred.succeed(releaseWorkflow, undefined),
            ]),
          )
          const client = Context.get(
            yield* Layer.build(FetchHttpClient.layer),
            HttpClient.HttpClient,
          )
          const send = (request: HttpClientRequest.HttpClientRequest) =>
            Effect.gen(function* () {
              const response = yield* client.execute(request)
              return { status: response.status, body: yield* response.json }
            })
          const probe = yield* Effect.provide(Probe.get("source"), context)
          const id = yield* Effect.provide(
            Effect.flatMap(ActorClient, (actors) => actors.mintCommandId),
            context,
          )
          const request = HttpClientRequest.post(
            new URL("/actors/LowConnectionProbe/source/Add", server.url).href,
            { headers: { "idempotency-key": id } },
          ).pipe(HttpClientRequest.bodyText("3", "application/json"))
          expect(yield* send(request)).toEqual({ status: 200, body: 3 })
          const run = yield* Effect.provide(probe.Work({ amount: 23 }), context)
          yield* Deferred.await(workflowStarted)
          yield* Effect.provide(probe.Stage(), context)
          yield* Deferred.await(jobStarted)
          const hold = yield* Effect.provide(probe.Hold(), context).pipe(Effect.forkScoped)
          yield* Deferred.await(holdStarted)
          yield* Deferred.succeed(releaseJob, undefined)
          yield* Deferred.succeed(releaseWorkflow, undefined)
          yield* Effect.sleep("1200 millis")

          expect(hold.pollUnsafe()).toBeUndefined()
          expect(
            yield* send(
              HttpClientRequest.post(
                new URL("/actors/LowConnectionProbe/source/Value", server.url).href,
              ),
            ),
          ).toEqual({ status: 200, body: 3 })
          expect(
            yield* send(HttpClientRequest.get(new URL("/inspector/overview", server.url).href)),
          ).toMatchObject({
            status: 200,
            body: { counts: { jobs: 1, openWorkflows: 1 } },
          })
          const [renewed] = yield* sql<{ attempts: number; remaining: number }>`SELECT attempts,
            due_at_ms - floor(extract(epoch FROM clock_timestamp()) * 1000) AS remaining
            FROM actor_outbox WHERE kind = 'job'`
          expect(renewed?.attempts).toBe(1)
          expect(Number(renewed?.remaining)).toBeGreaterThan(2000)
          expect(
            yield* sql`SELECT attempts FROM actor_outbox WHERE kind = 'intent' AND target_id = 'relay'`,
          ).toEqual([{ attempts: 1 }])
          yield* Deferred.succeed(releaseTurn, undefined)
          yield* Fiber.join(hold)
          expect(yield* run.result.pipe(Effect.provide(context))).toBe(23)
          yield* sql`SELECT 1 FROM actor_outbox`.pipe(
            Effect.flatMap((rows) => (rows.length === 0 ? Effect.void : Effect.fail("pending"))),
            Effect.retry({ times: 200, schedule: Schedule.spaced("10 millis") }),
          )
          expect(yield* Effect.provide(probe.Value(), context)).toBe(115)
          expect(
            yield* Effect.provide(
              Effect.flatMap(Probe.get("job"), (actor) => actor.Value()),
              context,
            ),
          ).toBe(11)
          expect(
            yield* Effect.provide(
              Effect.flatMap(Probe.get("relay"), (actor) => actor.Value()),
              context,
            ),
          ).toBe(7)
          expect(yield* send(request)).toEqual({ status: 200, body: 3 })
          expect(yield* Effect.provide(probe.Value(), context)).toBe(115)

          const interrupted = yield* Effect.provide(probe.Work({ amount: -1 }), context)
          yield* Deferred.await(interruptStarted)
          yield* Effect.provide(interrupted.interrupt, context)
          const exit = yield* Effect.provide(interrupted.result, context).pipe(Effect.exit)
          expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true)
          expect(
            yield* send(HttpClientRequest.get(new URL("/ready", server.url).href)),
          ).toMatchObject({ status: 200, body: { ready: true } })
          expect(yield* Effect.provide(probe.Add(17), context)).toBe(132)

          const sleeping = yield* Effect.provide(probe.Work({ amount: 31 }), context)
          yield* sql`SELECT 1 FROM actor_workflow_executions
            WHERE execution_id = ${sleeping.executionId} AND status = 'suspended'`.pipe(
            Effect.flatMap((rows) => (rows.length === 1 ? Effect.void : Effect.fail("not parked"))),
            Effect.retry({ times: 200, schedule: Schedule.spaced("10 millis") }),
          )
          yield* Scope.close(appScope, Exit.void)
          const recovered = yield* Layer.build(app)
          const attached = yield* Effect.provide(Probe.run(Work, sleeping.executionId), recovered)
          expect(yield* Effect.provide(attached.result, recovered)).toBe(54)
          const recoveredSql = Context.get(recovered, SqlClient.SqlClient)
          expect(
            yield* recoveredSql`SELECT count(*)::int AS count FROM actor_receipts
            WHERE actor_id = 'workflow' AND command = 'Add'`,
          ).toEqual([{ count: 2 }])
          expect(
            yield* Effect.provide(
              Effect.flatMap(Probe.get("workflow"), (actor) => actor.Value()),
              recovered,
            ),
          ).toBe(54)
        }).pipe(Effect.timeout("15 seconds")),
      ),
    ))
})
