import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import {
  Config,
  type Crypto,
  Deferred,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Schedule,
  Schema,
  type Scope,
} from "effect"
import { SqlClient } from "effect/sql"
import { afterAll, describe, expect, it } from "vitest"
import { Actor, Intent } from "../../index.ts"
import { ActorTest } from "../../testing/actor-test.ts"
import { disposableDatabase } from "../../testing/database.ts"
import { Database } from "../layer.ts"
import { routingKey } from "../storage/codec.ts"
import { UsageAccounting } from "../telemetry/usage.ts"
import { migrate } from "./migrations.ts"
import { type BucketRange, type Placement, ShardDirectory, ShardMap } from "./shards.ts"

const runtime = ManagedRuntime.make(BunCrypto.layer)
afterAll(() => runtime.dispose())

/** The framework's per-actor tables, each routed by `routing_key` once a database routes actor data. */
const routed = [
  "actor_blobs",
  "actor_connections",
  "actor_content_refs",
  "actor_dead_letters",
  "actor_events",
  "actor_generations",
  "actor_operator_audit",
  "actor_outbox",
  "actor_receipts",
  "actor_state",
  "actor_subscription_cursors",
  "actor_subscription_tags",
  "actor_subscriptions",
  "actor_workflow_executions",
  "actor_workflow_step",
  "tenant_content_chunks",
  "tenant_content_sweeps",
  "tenant_contents",
]

/**
 * Postgres has one copy of every row, so a session's `__neki.shard` cannot
 * change what it reads. The guard stands in for the router: it records every
 * committed write to a routed table with the session's target and the shard
 * `shard_guard_owner` says holds the row's bucket. A write rolled back leaves
 * no record, so a mismatch is a write that would have committed on a shard
 * that does not hold the row.
 */
const installGuard = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE shard_guard_owner (bucket integer PRIMARY KEY, shard text NOT NULL)`
  yield* sql`CREATE TABLE shard_guard_revision (revision bigint NOT NULL)`
  yield* sql`INSERT INTO shard_guard_revision VALUES (1)`
  yield* sql`INSERT INTO shard_guard_owner
    SELECT b, CASE WHEN b < 0 THEN 'shard-a' ELSE 'shard-b' END FROM generate_series(-128, 127) b`
  yield* sql`CREATE TABLE shard_guard_writes (
    tbl text NOT NULL, op text NOT NULL, bucket integer NOT NULL, session text, owner text)`
  yield* sql.unsafe(`CREATE FUNCTION shard_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      key bigint := CASE WHEN TG_OP = 'DELETE' THEN OLD.routing_key ELSE NEW.routing_key END;
    BEGIN
      INSERT INTO shard_guard_writes
        SELECT TG_TABLE_NAME, TG_OP, (key >> 56)::integer,
          nullif(current_setting('__neki.shard', true), ''), o.shard
        FROM shard_guard_owner o WHERE o.bucket = (key >> 56)::integer;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END $$`)
  for (const table of routed)
    yield* sql.unsafe(`CREATE TRIGGER shard_guard BEFORE INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION shard_guard()`)
})

const database = <A, E>(
  body: Effect.Effect<A, E, SqlClient.SqlClient | PgClient.PgClient | Scope.Scope | Crypto.Crypto>,
) =>
  runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const url = yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") })
        const client = yield* Layer.build(Database.postgres({ url, offTurnConnections: 2 }))
        yield* migrate.pipe(Effect.provideContext(client))
        yield* installGuard.pipe(Effect.provideContext(client))
        yield* installControl.pipe(Effect.provideContext(client))

        return yield* body.pipe(Effect.provideContext(client))
      }),
    ),
  )

const Stage = Actor.command("Stage", { payload: Schema.String })
const Record = Actor.command("Record", { payload: Schema.String })
const Touch = Actor.command("Touch")
const Hold = Actor.command("Hold")
const Beat = Actor.command("Beat")
const Seen = Actor.event("Seen", { value: Schema.String })
const Job = Actor.job("Job", { payload: {}, success: Schema.String })
const Capped = Actor.job("Capped", { payload: {}, success: Schema.String })
const Slow = Actor.job("Slow", { payload: {}, success: Schema.String })

/** The running `Slow` attempt reports here, and finishes once released. */
let slow = { started: Deferred.makeUnsafe<void>(), release: Deferred.makeUnsafe<void>() }

const Routed = Actor.make("Routed", {
  key: Schema.String,
  placement: "actor",
  state: Actor.state({
    seen: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  events: [Seen],
  api: { Stage, Touch, Hold },
  internal: { Record, Beat },
  schedules: { "@every 1 minute": Beat },
  policy: { keepReceipts: "1 second", keepEvents: "1 second" },
  jobs: {
    Job: { job: Job, onSuccess: Record },
    Capped: { job: Capped, concurrency: { perActor: 1 }, onSuccess: Record },
    Slow: { job: Slow, onSuccess: Record },
  },
})

const record = (value: string) =>
  Effect.gen(function* () {
    const turn = yield* Routed.Turn
    yield* turn.state.set({ seen: [...turn.state.seen, value] })
    yield* turn.emit(Seen.make({ value }))
  })

const actors = Layer.mergeAll(
  Routed.toLayer(
    Effect.succeed({
      Stage: (target) =>
        Effect.gen(function* () {
          const turn = yield* Routed.Turn
          yield* (yield* Routed.intents(target)).Record("from another shard")
          yield* (yield* Routed.intents(turn.id)).Record("timer").pipe(Intent.after("1 second"))
          yield* turn.enqueue(Job.make({}))
          yield* turn.enqueue(Capped.make({}))
        }),
      Touch: () => record("touch"),
      Hold: () =>
        Effect.gen(function* () {
          const turn = yield* Routed.Turn
          yield* turn.enqueue(Slow.make({}))
        }),
      Record: (value) => record(value),
      Beat: () => record("cron"),
    }),
  ),
  Routed.toJobLayer(
    Effect.succeed({
      Job: () => Effect.succeed("job"),
      Capped: () => Effect.succeed("capped"),
      Slow: () =>
        Deferred.succeed(slow.started, undefined).pipe(
          Effect.andThen(Deferred.await(slow.release)),
          Effect.as("slow"),
        ),
    }),
  ),
)

const Bump = Actor.command("Bump", { success: Schema.Int })
const Plan = Actor.command("Plan")
const Count = Actor.query("Count", { success: Schema.Int })
const Tick = Actor.job("Tick", { payload: {}, success: Schema.Void })
const Counted = Actor.event("Counted", { value: Schema.String })

/**
 * A control-plane actor: its handler counts its turns in a table the topology
 * does not route, as `BillingActor` or `CloudRunners` read and write theirs.
 */
const Controller = Actor.make("Controller", {
  key: Schema.String,
  placement: "authority",
  state: Actor.state({
    bumps: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  events: [Counted],
  api: { Bump, Plan, Count },
  jobs: { Tick: { job: Tick, onSuccess: Bump } },
})

const bump = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const turn = yield* Controller.Turn
  const bumps = turn.state.bumps + 1
  yield* turn.state.set({ bumps })
  yield* turn.emit(Counted.make({ value: String(bumps) }))
  yield* sql`INSERT INTO routing_control VALUES (${turn.id}, 1)
    ON CONFLICT (actor_id) DO UPDATE SET bumps = routing_control.bumps + 1`.pipe(Effect.orDie)
  return bumps
})

const controller = Layer.mergeAll(
  Controller.toLayer(
    Effect.succeed({
      Bump: () => bump,
      Plan: () =>
        Effect.gen(function* () {
          const turn = yield* Controller.Turn
          yield* (yield* Controller.intents(turn.id)).Bump().pipe(Intent.after("1 second"))
          yield* turn.enqueue(Tick.make({}))
        }),
    }),
  ),
  Controller.toJobLayer(Effect.succeed({ Tick: () => Effect.void })),
  Controller.toQueryLayer({
    Count: () => Effect.map(Controller.Read, (read) => read.state.bumps),
  }),
)

/** Records the session target of every write to the control table. */
const installControl = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE routing_control (actor_id text PRIMARY KEY, bumps integer NOT NULL)`
  yield* sql`CREATE TABLE routing_control_writes (session text)`
  yield* sql.unsafe(`CREATE FUNCTION routing_control_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO routing_control_writes VALUES (nullif(current_setting('__neki.shard', true), ''));
      RETURN NEW;
    END $$`)
  yield* sql`CREATE TRIGGER routing_control_guard BEFORE INSERT OR UPDATE ON routing_control
    FOR EACH ROW EXECUTE FUNCTION routing_control_guard()`
})

/** The shards of the guard's initial owners: negative buckets on `shard-a`, the rest on `shard-b`. */
const split: ReadonlyArray<BucketRange> = [
  { first: -128, last: -1, shard: "shard-a" },
  { first: 0, last: 127, shard: "shard-b" },
]

/** An id of `Routed` whose routing key is negative, or not. */
const idOn = (tenant: string, negative: boolean, after = -1) => {
  let id = after + 1
  while (
    routingKey({ ref: { tenant, actor: "Routed", id: String(id) }, placement: "actor" }) < 0n !==
    negative
  )
    id++
  return id
}

const runActors = <A, E, R, M, X = never>(
  map: Layer.Layer<M>,
  body: Effect.Effect<A, E, R>,
  extra: Layer.Layer<X> = Layer.empty as Layer.Layer<X>,
) =>
  Effect.gen(function* () {
    const postgres = yield* PgClient.PgClient
    const context = yield* Layer.build(
      Layer.mergeAll(actors, controller).pipe(
        Layer.provideMerge(
          ActorTest.layer({
            database: postgres.config.url!,
            relay: { deliveryConcurrency: 2 },
            executors: { concurrency: 2 },
            retryWindowMs: 5_000,
          }),
        ),
        Layer.provide(map),
        Layer.provide(extra),
      ),
    )

    return yield* body.pipe(Effect.provideContext(context))
  })

const writes = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<{ tbl: string; op: string; bucket: number; session: string | null; owner: string }>`
    SELECT tbl, op, bucket, session, owner FROM shard_guard_writes`,
)

/** A directory whose router is the guard's tables, read on refresh only, like Neki's. */
const guardDirectory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  let revision = "1"
  let ranges: ReadonlyArray<BucketRange> = split
  let refreshes = 0
  let placement: Placement = { authoritative: undefined, routes: () => true }

  const read = Effect.gen(function* () {
    const [row] = yield* sql<{
      revision: string
    }>`SELECT revision::text AS revision FROM shard_guard_revision`
    const owners = yield* sql<{ bucket: number; shard: string }>`
      SELECT bucket, shard FROM shard_guard_owner ORDER BY bucket`
    const next: Array<BucketRange> = []
    for (const owner of owners) {
      const last = next.at(-1)
      if (last !== undefined && last.shard === owner.shard && last.last === owner.bucket - 1)
        next[next.length - 1] = { ...last, last: owner.bucket }
      else next.push({ first: owner.bucket, last: owner.bucket, shard: owner.shard })
    }
    revision = row!.revision
    ranges = next
    refreshes++
  }).pipe(Effect.orDie)

  return {
    directory: ShardDirectory.of({
      ranges: Effect.sync(() => ranges),
      revision: Effect.sync(() => revision),
      revisionStatement: "SELECT revision::text AS revision FROM shard_guard_revision",
      refresh: read,
      placement: Effect.sync(() => placement),
    }),
    refreshes: () => refreshes,
    place: (next: Placement) => {
      placement = next
    },
  }
})

/** Moves `bucket` to `shard` on the guard's router and bumps its revision, as a reshard's cutover does. */
const move = (bucket: number, shard: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.andThen(
      sql`UPDATE shard_guard_owner SET shard = ${shard} WHERE bucket = ${bucket}`,
      sql`UPDATE shard_guard_revision SET revision = revision + 1`,
    ),
  )

describe("shard-targeted sessions with Postgres", () => {
  it(
    "writes every routed row from a session targeted at its own shard, across turns, cross-shard intents, timers, jobs, cron and retention",
    () =>
      database(
        runActors(
          Layer.succeed(ShardMap, split),
          Effect.gen(function* () {
            const test = yield* ActorTest
            const sql = yield* SqlClient.SqlClient
            const negative = idOn(test.tenant, true)
            const positive = idOn(test.tenant, false)
            const low = yield* Routed.get(String(negative))
            const high = yield* Routed.get(String(positive))
            yield* low.Stage(String(positive))
            yield* high.Stage(String(negative))
            yield* test.advance("1 minute")
            yield* test.advance(0)
            for (const handle of [low, high]) {
              const state = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ seen: Schema.Array(Schema.String) }),
              )((yield* test.inspect(handle.ref)).state)
              expect([...state.seen].sort()).toEqual([
                "capped",
                "cron",
                "from another shard",
                "job",
                "timer",
              ])
            }
            yield* test.advance("1 minute")
            const swept = yield* test.cleanup
            expect(swept.receipts).toBeGreaterThan(0)
            expect(swept.events).toBeGreaterThan(0)

            const seen = yield* writes
            expect(seen.filter((write) => write.session !== write.owner)).toEqual([])
            expect(new Set(seen.map((write) => write.session))).toEqual(
              new Set(["shard-a", "shard-b"]),
            )
            for (const op of ["INSERT", "UPDATE", "DELETE"])
              expect(seen.some((write) => write.op === op && write.tbl === "actor_outbox")).toBe(
                true,
              )
            expect(
              seen.some((write) => write.op === "DELETE" && write.tbl === "actor_receipts"),
            ).toBe(true)
            expect(
              seen.some((write) => write.op === "DELETE" && write.tbl === "actor_events"),
            ).toBe(true)
            const coordination = yield* sql<{ resource: string }>`
            SELECT resource FROM actor_coordination WHERE resource LIKE 'local/%' ORDER BY resource`
            expect(coordination.map((row) => row.resource)).toContain(
              "local/akter/retention/Routed",
            )
          }),
        ),
      ),
    60_000,
  )

  it("extends a running attempt's lease from its own shard when a caller outside the runtime advances the clock", () =>
    database(
      runActors(
        Layer.succeed(ShardMap, split),
        Effect.gen(function* () {
          slow = { started: Deferred.makeUnsafe<void>(), release: Deferred.makeUnsafe<void>() }
          const test = yield* ActorTest
          const handle = yield* Routed.get(String(idOn(test.tenant, true)))
          yield* handle.Hold()
          yield* Deferred.await(slow.started).pipe(Effect.timeout("10 seconds"))
          const before = (yield* writes).length
          const advancing = yield* test.advance("1 second").pipe(Effect.forkChild)
          const sql = yield* SqlClient.SqlClient
          yield* sql<{ n: number }>`SELECT count(*)::int AS n FROM shard_guard_writes`.pipe(
            Effect.repeat({
              until: ([row]) => row!.n > before,
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("10 seconds"),
          )
          yield* Deferred.succeed(slow.release, undefined)
          yield* Fiber.join(advancing)
          const seen = yield* writes
          expect(
            seen
              .slice(before)
              .some((write) => write.op === "UPDATE" && write.tbl === "actor_outbox"),
          ).toBe(true)
          expect(seen.filter((write) => write.session !== write.owner)).toEqual([])
          const state = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ seen: Schema.Array(Schema.String) }),
          )((yield* test.inspect(handle.ref)).state)
          expect(state.seen).toEqual(["slow"])
        }),
      ),
    ))

  it.each([
    { name: "warm", warm: true },
    { name: "cold", warm: false },
  ])(
    "fails a $name turn closed when the router moved its bucket after the map was read, then commits it once on the new shard",
    ({ warm }) =>
      database(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const guard = yield* guardDirectory
          yield* guard.directory.refresh

          yield* runActors(
            Layer.succeed(ShardDirectory, guard.directory),
            Effect.gen(function* () {
              const test = yield* ActorTest
              const id = idOn(test.tenant, true)
              const handle = yield* Routed.get(String(id))
              const key = routingKey({
                ref: { tenant: test.tenant, actor: "Routed", id: String(id) },
                placement: "actor",
              })
              const bucket = Number(key >> 56n)

              if (warm) yield* handle.Touch()

              const before = guard.refreshes()
              yield* move(bucket, "shard-b")
              expect(yield* guard.directory.revision).toBe("1")
              yield* handle.Touch()

              expect(guard.refreshes()).toBeGreaterThan(before)
              expect(yield* guard.directory.revision).toBe("2")
              expect(yield* test.receiptsFor(handle.ref, "Touch")).toBe(warm ? 2 : 1)
              const state = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ seen: Schema.Array(Schema.String) }),
              )((yield* test.inspect(handle.ref)).state)
              expect(state.seen).toEqual(warm ? ["touch", "touch"] : ["touch"])
              const mine = (yield* writes).filter((write) => write.bucket === bucket)
              expect(mine.filter((write) => write.session !== write.owner)).toEqual([])
              expect(
                mine.some((write) => write.session === "shard-b" && write.tbl === "actor_receipts"),
              ).toBe(true)
            }),
          )

          expect(
            yield* sql`SELECT tbl, bucket, session, owner FROM shard_guard_writes WHERE session IS DISTINCT FROM owner`,
          ).toEqual([])
        }),
      ),
  )

  it("runs an authority-placed actor's turns, timers, jobs and queries on the authoritative shard that holds its bucket, and fails them closed once its bucket moves to a data shard", () =>
    database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const guard = yield* guardDirectory
        yield* guard.directory.refresh
        guard.place({ authoritative: "shard-a", routes: (table) => routed.includes(table) })

        yield* runActors(
          Layer.succeed(ShardDirectory, guard.directory),
          Effect.gen(function* () {
            const test = yield* ActorTest
            const handle = yield* Controller.get("billing")
            const key = routingKey({ ref: handle.ref, placement: "authority" })

            expect(key >> 56n).toBe(-128n)
            expect(yield* handle.Bump()).toBe(1)
            yield* handle.Plan()
            yield* test.advance("1 second")
            yield* test.advance(0)
            expect(yield* handle.Count()).toBe(3)
            expect(yield* sql`SELECT bumps FROM routing_control`).toEqual([{ bumps: 3 }])

            const mine = (yield* writes).filter((write) => write.bucket === -128)
            expect(new Set(mine.map((write) => write.tbl))).toEqual(
              new Set([
                "actor_events",
                "actor_generations",
                "actor_outbox",
                "actor_receipts",
                "actor_state",
              ]),
            )
            expect(mine.filter((write) => write.session !== "shard-a")).toEqual([])
            expect(yield* sql`SELECT DISTINCT session FROM routing_control_writes`).toEqual([
              { session: "shard-a" },
            ])

            const receipts = yield* test.receiptsFor(handle.ref, "Bump")
            yield* move(-128, "shard-b")
            yield* guard.directory.refresh
            const refused = yield* handle.Bump().pipe(Effect.exit)
            expect(String(refused)).toContain(
              "Controller is authority-placed, but the topology puts its bucket on shard shard-b, not on the authoritative shard shard-a",
            )
            expect(String(yield* handle.Count().pipe(Effect.exit))).toContain(
              "Controller is authority-placed",
            )
            expect(yield* test.receiptsFor(handle.ref, "Bump")).toBe(receipts)
            expect(yield* sql`SELECT bumps FROM routing_control`).toEqual([{ bumps: 3 }])
          }),
        )
      }),
    ))

  it("refuses a turn that writes host rows from a data shard other than the authoritative one, and runs it on the authoritative shard", () =>
    database(
      Effect.gen(function* () {
        const guard = yield* guardDirectory
        yield* guard.directory.refresh
        guard.place({ authoritative: "shard-a", routes: () => true })
        const accounted: Array<string> = []

        yield* runActors(
          Layer.succeed(ShardDirectory, guard.directory),
          Effect.gen(function* () {
            const test = yield* ActorTest
            const data = yield* Routed.get(String(idOn(test.tenant, false)))
            const authoritative = yield* Routed.get(String(idOn(test.tenant, true)))
            const refused = yield* data.Touch().pipe(Effect.exit)
            expect(refused._tag).toBe("Failure")
            expect(String(refused)).toContain("which stay on the authoritative shard")
            expect((yield* test.inspect(data.ref)).receipts).toBe(0)
            yield* authoritative.Touch()
            expect(yield* test.receiptsFor(authoritative.ref, "Touch")).toBe(1)
            expect(accounted).toHaveLength(1)
          }),
          Layer.succeed(UsageAccounting, {
            commands: ({ commandIds, sql }) =>
              Effect.asVoid(sql`SELECT 1`).pipe(
                Effect.tap(() => Effect.sync(() => accounted.push(...commandIds))),
              ),
            read: () => Effect.void,
          }),
        )
      }),
    ))
})
