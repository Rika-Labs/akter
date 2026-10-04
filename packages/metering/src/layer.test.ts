import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { Actor } from "@rikalabs/akter"
import { UsageAccounting, type UsageAccountingService } from "@rikalabs/akter/runtime"
import { ActorTest, InternalActors } from "@rikalabs/akter/testing"
import {
  Config,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Schema,
  Stream,
} from "effect"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"

import {
  CellUsage,
  DeploymentMismatch,
  HourNotEnded,
  HourNotSealed,
  StorageSampleUnavailable,
  StorageNotObservable,
  UnknownEvents,
} from "./contract.ts"
import { CellUsageLive } from "./layer.ts"

const DEPLOYMENT = "dep_test"

/** A fresh database on the server at TEST_DATABASE_URL, dropped with the scope. */
const database = Effect.gen(function* () {
  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `metering_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href })),
    (pool) => Effect.promise(() => pool.end()),
  )

  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
  )
  base.pathname = `/${name}`

  return Redacted.make(base.href)
})

class Rejected extends Schema.TaggedError<Rejected>()("Rejected", { amount: Schema.Int }) {}

const Increment = Actor.command("Increment", { payload: Schema.Int, success: Schema.Int })
const Reject = Actor.command("Reject", { payload: Schema.Int, error: Rejected })
const Boom = Actor.command("Boom")
const Count = Actor.query("Count", { success: Schema.Int })
const Total = Actor.query("Total", { success: Schema.Int, watch: true })

const Counter = Actor.make("MeteredCounter", {
  key: Schema.String,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Increment, Reject, Boom, Count, Total },
})

const CounterLive = Counter.toLayer(
  Effect.succeed({
    Increment: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* Counter.Turn
      yield* turn.state.set({ count: turn.state.count + amount })

      return turn.state.count
    }),
    Reject: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* Counter.Turn
      yield* turn.state.set({ count: 999 })

      return yield* Rejected.make({ amount })
    }),
    Boom: () => Effect.die(new Error("handler defect")),
  }),
)

const CounterReads = Counter.toQueryLayer(
  Effect.succeed({
    Count: Effect.fnUntraced(function* () {
      return (yield* Counter.Read).state.count
    }),
    Total: Effect.fnUntraced(function* () {
      return (yield* Counter.Read).state.count
    }),
  }),
)

class DatabaseUrl extends Context.Service<DatabaseUrl, Redacted.Redacted<string>>()(
  "@akter/metering/layer.test/DatabaseUrl",
) {}

const live = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* database
    const usage = CellUsageLive({ deploymentId: DEPLOYMENT }).pipe(
      Layer.provideMerge(PgClient.layer({ url, maxConnections: 8 })),
    )
    const test = ActorTest.layer({ database: url }).pipe(Layer.provide(usage))

    return Layer.mergeAll(CounterLive, CounterReads).pipe(
      Layer.provideMerge(test),
      Layer.provideMerge(usage),
      Layer.merge(Layer.succeed(DatabaseUrl, url)),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer), Layer.orDie)

const runtime = ManagedRuntime.make(live)

afterAll(() => runtime.dispose())

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof live>>) =>
  runtime.runPromise(effect)

const emptyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* database
    return CellUsageLive({ deploymentId: DEPLOYMENT }).pipe(
      Layer.provideMerge(PgClient.layer({ url })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer), Layer.orDie)

const runEmpty = <A, E>(effect: Effect.Effect<A, E, CellUsage | SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.scoped(
      Layer.build(emptyLayer).pipe(
        Effect.flatMap((context) => effect.pipe(Effect.provideContext(context))),
      ),
    ),
  )

interface JournalRow {
  readonly kind: string
  readonly deployment_id: string
  readonly tenant_id: string
  readonly actor_type: string
  readonly actor_id: string
  readonly command_id: string | null
  readonly request_token: string | null
}

const journalOf = (actorId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<JournalRow>`
      SELECT kind, deployment_id, tenant_id, actor_type, actor_id, command_id, request_token
      FROM cloud_meter_cell_journal WHERE actor_id = ${actorId} ORDER BY recorded_at, event_id`
  }).pipe(Effect.orDie)

const tokened = (token: string) =>
  Effect.provideServiceEffect(
    InternalActors,
    Effect.map(InternalActors, (actors) => ({
      ...actors,
      query: (request, version) => actors.query({ ...request, usageToken: token }, version),
      watch: (request, options) => actors.watch({ ...request, usageToken: token }, options),
    })),
  )

const hourAgo = (hours: number) =>
  DateTime.now.pipe(
    Effect.map((now) => DateTime.subtract(DateTime.startOf(now, "hour"), { hours })),
  )

const insertAt = (hour: DateTime.Utc, label: string, kind: "command" | "read" = "command") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const stamp = DateTime.formatIso(hour)

    yield* sql`
      INSERT INTO cloud_meter_cell_journal
        (deployment_id, tenant_id, actor_type, actor_id, command_id, kind, hour, recorded_at)
      VALUES (${DEPLOYMENT}, 'seeded', 'Seeded', ${label}, ${kind === "command" ? label : null},
        ${kind}, ${stamp}::timestamptz, clock_timestamp())`
  }).pipe(Effect.orDie)

describe("command journal", () => {
  it("records a committed command once and not again on replay", () =>
    run(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const counter = yield* Counter.get("committed")
        const increment = counter.Increment(5)

        expect(yield* increment).toBe(5)
        expect(yield* increment).toBe(5)

        const rows = yield* journalOf("committed")

        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          kind: "command",
          deployment_id: DEPLOYMENT,
          tenant_id: test.tenant,
          actor_type: "MeteredCounter",
          request_token: null,
        })
        expect(rows[0]!.command_id).not.toBeNull()
        expect(yield* test.receiptsFor(counter.ref, "Increment")).toBe(1)
      }),
    ))

  it("records a command that ended in a declared failure, which committed a receipt", () =>
    run(
      Effect.gen(function* () {
        const counter = yield* Counter.get("rejected")
        const reject = counter.Reject(3)

        expect(yield* Effect.flip(reject)).toBeInstanceOf(Rejected)
        expect(yield* Effect.flip(reject)).toBeInstanceOf(Rejected)
        expect(yield* journalOf("rejected")).toHaveLength(1)
      }),
    ))

  it("records nothing for a command that died, which rolled back with no receipt", () =>
    run(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const counter = yield* Counter.get("died")

        expect(Exit.isFailure(yield* Effect.exit(counter.Boom()))).toBe(true)
        expect(yield* journalOf("died")).toHaveLength(0)
        expect(yield* test.receiptsFor(counter.ref, "Boom")).toBe(0)
      }),
    ))

  it("records exactly once when the turn crashes before its commit and is retried", () =>
    run(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const counter = yield* Counter.get("crash-before")

        yield* test.crashNext("beforeCommit")
        expect(yield* counter.Increment(2)).toBe(2)

        expect(yield* journalOf("crash-before")).toHaveLength(1)
        expect(yield* test.receiptsFor(counter.ref, "Increment")).toBe(1)
      }),
    ))

  it("records exactly once when the turn crashes after its commit and is retried", () =>
    run(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const counter = yield* Counter.get("crash-after")

        yield* test.crashNext("afterCommit")
        expect(yield* counter.Increment(4)).toBe(4)

        expect(yield* journalOf("crash-after")).toHaveLength(1)
        expect(yield* test.receiptsFor(counter.ref, "Increment")).toBe(1)
      }),
    ))

  it("keeps its row and its once-only guarantee after retention prunes the receipt", () =>
    run(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const counter = yield* Counter.get("pruned")
        const accounting = yield* UsageAccounting
        const sql = yield* SqlClient.SqlClient

        yield* counter.Increment(1)
        const [row] = yield* journalOf("pruned")
        yield* test.advance("400 days")
        yield* test.cleanup

        expect(yield* test.receiptsFor(counter.ref, "Increment")).toBe(0)
        expect(yield* journalOf("pruned")).toHaveLength(1)

        yield* accounting.commands({ ref: counter.ref, commandIds: [row!.command_id!], sql })

        expect(yield* journalOf("pruned")).toHaveLength(1)
      }),
    ))
})

describe("an empty cell database", () => {
  it("returns an empty current-hour sample without encoding empty SQL arrays", () =>
    runEmpty(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const [row] = yield* sql<{ hour: Date }>`
        SELECT date_trunc('hour', clock_timestamp(), 'UTC') AS hour`
        const sample = yield* (yield* CellUsage).sampleStorage(DateTime.fromDateUnsafe(row!.hour))
        expect(sample.samples).toEqual([])
        expect(sample.tables).toEqual([])
        expect(yield* (yield* CellUsage).earliestHour).toBeNull()
      }),
    ))

  it("acknowledges an empty list as zero without encoding an empty UUID array", () =>
    runEmpty(
      Effect.gen(function* () {
        expect(yield* (yield* CellUsage).ack([])).toBe(0)
        expect(yield* (yield* CellUsage).earliestHour).toBeNull()
      }),
    ))
})

describe("read journal", () => {
  it("records a read once per token and every tokenless read", () =>
    run(
      Effect.gen(function* () {
        const read = Effect.gen(function* () {
          return yield* (yield* Counter.get("reads")).Count()
        })

        yield* Counter.get("reads").pipe(Effect.flatMap((counter) => counter.Increment(1)))
        yield* read.pipe(tokened("token-a"))
        yield* read.pipe(tokened("token-a"))
        yield* read.pipe(tokened("token-b"))
        yield* read
        yield* read

        const reads = (yield* journalOf("reads")).filter((row) => row.kind === "read")

        expect(
          reads.map((row) => row.request_token ?? "").toSorted((a, b) => a.localeCompare(b)),
        ).toEqual(["", "", "token-a", "token-b"])
      }),
    ))

  it("records a watch once for its token however often it reruns, and a tokenless watch not at all", () =>
    run(
      Effect.gen(function* () {
        const watched = (name: string) =>
          Effect.gen(function* () {
            return yield* (yield* Counter.get(name)).Total.watch().pipe(
              Stream.take(3),
              Stream.runCollect,
            )
          })
        const bump = (name: string, amount: number) =>
          Counter.get(name).pipe(Effect.flatMap((counter) => counter.Increment(amount)))

        yield* bump("watch-token", 0)
        yield* bump("watch-free", 0)
        const withToken = yield* watched("watch-token").pipe(tokened("watch-1"), Effect.forkChild)
        const without = yield* watched("watch-free").pipe(Effect.forkChild)
        yield* Effect.sleep("200 millis")
        yield* bump("watch-token", 1)
        yield* bump("watch-free", 1)
        yield* Effect.sleep("300 millis")
        yield* bump("watch-token", 1)
        yield* bump("watch-free", 1)
        const seen = yield* Fiber.join(withToken)
        yield* Fiber.join(without)

        const counted = (yield* journalOf("watch-token")).filter((row) => row.kind === "read")

        expect(seen.length).toBe(3)
        expect(counted.map((row) => row.request_token)).toEqual(["watch-1"])
        expect((yield* journalOf("watch-free")).filter((row) => row.kind === "read")).toEqual([])
      }),
    ))
})

describe("sealing and import", () => {
  it("refuses an hour that has not ended and seals one that has", () =>
    run(
      Effect.gen(function* () {
        const usage = yield* CellUsage
        const now = yield* DateTime.now
        const past = yield* hourAgo(5)

        expect(
          yield* Effect.flip(usage.sealAndPending(DateTime.startOf(now, "hour"))),
        ).toBeInstanceOf(HourNotEnded)

        yield* insertAt(past, "sealed-1")
        const page = yield* usage.sealAndPending(DateTime.add(past, { minutes: 30 }))

        expect(page.hour).toEqual(past)
        expect(page.events.map((event) => event.commandId)).toEqual(["sealed-1"])
        expect(page.complete).toBe(true)
        expect(page.events[0]).toMatchObject({
          kind: "command",
          deploymentId: DEPLOYMENT,
          tenant: "seeded",
          storageByteHours: null,
          acknowledged: false,
        })
      }),
    ))

  it("pages an hour's pending events and acknowledges only sealed ones, once", () =>
    run(
      Effect.gen(function* () {
        const usage = yield* CellUsage
        const hour = yield* hourAgo(6)

        for (const label of ["p1", "p2", "p3", "p4", "p5"]) yield* insertAt(hour, label)

        const first = yield* usage.sealAndPending(hour, 2)
        const second = yield* usage.sealAndPending(hour, 2, first.events.at(-1)!.eventId)
        const third = yield* usage.sealAndPending(hour, 2, second.events.at(-1)!.eventId)
        const ids = [...first.events, ...second.events, ...third.events].map(
          (event) => event.eventId,
        )

        expect([first.events.length, second.events.length, third.events.length]).toEqual([2, 2, 1])
        expect([first.complete, second.complete, third.complete]).toEqual([false, false, true])
        expect(new Set(ids).size).toBe(5)

        expect(yield* usage.ack(first.events.map((event) => event.eventId))).toBe(2)
        expect(yield* usage.ack(first.events.map((event) => event.eventId))).toBe(0)

        const remaining = yield* usage.sealAndPending(hour)

        expect(remaining.events.map((event) => event.eventId).toSorted()).toEqual(
          [...second.events, ...third.events].map((event) => event.eventId).toSorted(),
        )
        expect(remaining.complete).toBe(true)

        yield* insertAt(DateTime.add(yield* DateTime.now, { hours: 3 }), "future-1")
        const sql = yield* SqlClient.SqlClient
        const [open] = yield* sql<{ event_id: string }>`
          SELECT event_id FROM cloud_meter_cell_journal WHERE command_id = 'future-1'`

        expect(yield* Effect.flip(usage.ack([open!.event_id]))).toBeInstanceOf(HourNotSealed)
      }),
    ))

  it("moves a row that arrives for a sealed hour into a later hour and refuses edits and deletes", () =>
    run(
      Effect.gen(function* () {
        const usage = yield* CellUsage
        const sql = yield* SqlClient.SqlClient
        const hour = yield* hourAgo(7)

        yield* insertAt(hour, "early")
        const before = yield* usage.sealAndPending(hour)
        yield* insertAt(hour, "late")
        const after = yield* usage.sealAndPending(hour)
        const [late] = yield* sql<{ hour: Date }>`
          SELECT hour FROM cloud_meter_cell_journal WHERE command_id = 'late'`

        expect(after.events).toEqual(before.events)
        expect(DateTime.toEpochMillis(DateTime.fromDateUnsafe(late!.hour))).toBeGreaterThan(
          DateTime.toEpochMillis(hour),
        )

        const edit = yield* Effect.exit(
          sql`UPDATE cloud_meter_cell_journal SET tenant_id = 'x' WHERE command_id = 'early'`,
        )
        const remove = yield* Effect.exit(
          sql`DELETE FROM cloud_meter_cell_journal WHERE command_id = 'early'`,
        )

        expect(Exit.isFailure(edit)).toBe(true)
        expect(Exit.isFailure(remove)).toBe(true)

        yield* usage.ack(before.events.map((event) => event.eventId))

        expect(
          Exit.isFailure(
            yield* Effect.exit(
              sql`UPDATE cloud_meter_cell_journal SET tenant_id = 'x' WHERE command_id = 'early'`,
            ),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              sql`DELETE FROM cloud_meter_cell_journal WHERE command_id = 'early'`,
            ),
          ),
        ).toBe(true)
        expect((yield* usage.sealAndPending(hour)).events).toEqual([])
        expect(
          (yield* sql<{ total: number }>`
            SELECT count(*)::int AS total FROM cloud_meter_cell_journal WHERE command_id = 'early'`)[0]!
            .total,
        ).toBe(1)
      }),
    ))

  it("waits for a transaction that is writing the journal before it seals", () =>
    run(
      Effect.gen(function* () {
        const usage = yield* CellUsage
        const sql = yield* SqlClient.SqlClient
        const accounting = yield* UsageAccounting
        const hour = yield* hourAgo(8)
        const test = yield* ActorTest
        const counter = yield* Counter.get("writer")
        const inserted = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        yield* insertAt(hour, "before-writer")
        const writer = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* accounting.commands({ ref: counter.ref, commandIds: ["writing"], sql })
              yield* Deferred.succeed(inserted, undefined)
              yield* Deferred.await(release)
            }),
          )
          .pipe(Effect.forkChild)

        yield* Deferred.await(inserted)
        const sealing = yield* usage.sealAndPending(hour).pipe(Effect.forkChild)
        yield* Effect.sleep("400 millis")

        expect(
          Option.isNone(yield* Fiber.await(sealing).pipe(Effect.timeoutOption("400 millis"))),
        ).toBe(true)
        expect(test.tenant).toBeDefined()

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(writer)
        const page = yield* Fiber.join(sealing)

        expect(page.events.map((event) => event.commandId)).toEqual(["before-writer"])
        expect((yield* journalOf("writer")).map((row) => row.command_id)).toEqual(["writing"])
      }),
    ))
})

describe("storage samples", () => {
  it("refuses an RLS-filtered scan after the initialized service's transaction changes role", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const initialized = yield* Layer.build(CellUsageLive({ deploymentId: DEPLOYMENT }))
          const usage = Context.get(initialized, CellUsage)
          const test = yield* ActorTest
          const role = `meter_limited_${new URL(Redacted.value(yield* DatabaseUrl)).pathname.slice(1)}`
          yield* (yield* Counter.get("hidden-storage")).Increment(1)
          yield* Effect.acquireRelease(
            sql`CREATE ROLE ${sql(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
            () =>
              sql`DROP OWNED BY ${sql(role)}`.pipe(
                Effect.andThen(sql`DROP ROLE ${sql(role)}`),
                Effect.orDie,
              ),
          )
          yield* sql`GRANT USAGE ON SCHEMA public TO ${sql(role)}`
          yield* sql`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${sql(role)}`
          const [before] = yield* sql<{ total: number }>`
        SELECT count(*)::integer AS total FROM cloud_meter_cell_journal WHERE kind = 'storage'`
          const denied = yield* sql.withTransaction(
            Effect.gen(function* () {
              const [stamp] = yield* sql<{ hour: Date }>`
          SELECT date_trunc('hour', clock_timestamp(), 'UTC') AS hour`
              yield* sql`SET LOCAL ROLE ${sql(role)}`
              const [filtered] = yield* sql<{
                total: number
              }>`SELECT count(*)::integer AS total FROM actor_state`
              expect(filtered!.total).toBe(0)
              return yield* Effect.flip(usage.sampleStorage(DateTime.fromDateUnsafe(stamp!.hour)))
            }),
          )
          expect(denied).toBeInstanceOf(StorageNotObservable)
          if (Schema.is(StorageNotObservable)(denied))
            expect(denied.tables).toContain("actor_state")
          const [after] = yield* sql<{ total: number }>`
        SELECT count(*)::integer AS total FROM cloud_meter_cell_journal WHERE kind = 'storage'`
          const [visible] = yield* sql<{ total: number }>`
        SELECT count(*)::integer AS total FROM actor_state WHERE tenant_id = ${test.tenant}`
          expect(after!.total).toBe(before!.total)
          expect(visible!.total).toBeGreaterThan(0)
        }),
      ),
    ))
  const currentHour = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      hour: Date
    }>`SELECT date_trunc('hour', clock_timestamp(), 'UTC') AS hour`

    return DateTime.fromDateUnsafe(row!.hour)
  }).pipe(Effect.orDie)

  const sampleOf = (tenant: string, hour: DateTime.Utc) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const [row] = yield* sql<{ total: number }>`
        SELECT count(*)::int AS total FROM cloud_meter_cell_journal
        WHERE kind = 'storage' AND tenant_id = ${tenant} AND hour = ${DateTime.formatIso(hour)}::timestamptz`

      return row!.total
    }).pipe(Effect.orDie)

  it("samples each tenant's logical bytes for the current hour and keeps the first sample", () =>
    run(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const usage = yield* CellUsage
        const sql = yield* SqlClient.SqlClient
        const hour = yield* currentHour

        yield* (yield* Counter.get("storage-a")).Increment(1)

        const [expected] = yield* sql<{ bytes: string }>`
          SELECT (
            (SELECT coalesce(sum(pg_column_size(t.*)), 0) FROM actor_generations t WHERE tenant_id = ${test.tenant}) +
            (SELECT coalesce(sum(pg_column_size(t.*)), 0) FROM actor_state t WHERE tenant_id = ${test.tenant}) +
            (SELECT coalesce(sum(pg_column_size(t.*)), 0) FROM actor_receipts t WHERE tenant_id = ${test.tenant})
          )::text AS bytes`

        const first = yield* usage.sampleStorage(hour)
        const independent = (yield* Effect.forEach(
          first.tables,
          (table) =>
            sql<{ size: number }>`
            SELECT pg_column_size(t) AS size FROM ${sql(table)} AS t WHERE tenant_id = ${test.tenant}`,
        ))
          .flat()
          .reduce((total, row) => total + Number(row.size), 0)
        yield* (yield* Counter.get("storage-b")).Increment(1)
        yield* (yield* Counter.get("storage-c")).Increment(9)
        const again = yield* usage.sampleStorage(hour)
        const mine = first.samples.find((sample) => sample.tenant === test.tenant)

        expect(mine!.logicalBytes).toBe(independent)
        expect(mine!.logicalBytes).toBeGreaterThanOrEqual(Number(expected!.bytes))
        expect(again.samples.find((sample) => sample.tenant === test.tenant)).toEqual(mine)
        expect(yield* sampleOf(test.tenant, hour)).toBe(1)
        expect(first.tables).toContain("actor_state")
        expect(first.tables).toContain("actor_receipts")
        expect(first.tables).toContain("tenant_contents")
        expect(first.tables).not.toContain("actor_deployment")
        expect(first.unattributedTables).toContain("actor_deployment")
        expect(first.tables.some((table) => table.startsWith("cloud_meter_"))).toBe(false)
        expect(first.unattributedTables.some((table) => table.startsWith("cloud_meter_"))).toBe(
          false,
        )
      }),
    ))

  it("makes up no sample for a past hour and returns only one already persisted", () =>
    run(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const usage = yield* CellUsage
        const sql = yield* SqlClient.SqlClient
        const unobserved = yield* hourAgo(11)
        const observed = yield* hourAgo(12)

        yield* (yield* Counter.get("storage-d")).Increment(1)

        expect(yield* Effect.flip(usage.sampleStorage(unobserved))).toEqual(
          StorageSampleUnavailable.make({ hour: DateTime.formatIso(unobserved) }),
        )
        expect(yield* sampleOf(test.tenant, unobserved)).toBe(0)

        yield* sql`
          INSERT INTO cloud_meter_cell_journal
            (deployment_id, tenant_id, actor_type, actor_id, kind, hour, recorded_at, storage_byte_hours)
          VALUES (${DEPLOYMENT}, 'fixture-tenant', '', '', 'storage',
            ${DateTime.formatIso(observed)}::timestamptz, clock_timestamp(), 4096)`

        const retried = yield* usage.sampleStorage(observed)

        expect(retried.samples).toEqual([{ tenant: "fixture-tenant", logicalBytes: 4096 }])
        expect(yield* sampleOf(test.tenant, observed)).toBe(0)
      }),
    ))

  it("imports a persisted storage sample as a storage event once its hour is sealed", () =>
    run(
      Effect.gen(function* () {
        const usage = yield* CellUsage
        const sql = yield* SqlClient.SqlClient
        const hour = yield* hourAgo(13)

        yield* sql`
          INSERT INTO cloud_meter_cell_journal
            (deployment_id, tenant_id, actor_type, actor_id, kind, hour, recorded_at, storage_byte_hours)
          VALUES (${DEPLOYMENT}, 'storage-fixture', '', '', 'storage',
            ${DateTime.formatIso(hour)}::timestamptz, clock_timestamp(), 8192)`

        const page = yield* usage.sealAndPending(hour)

        expect(page.events).toHaveLength(1)
        expect(page.events[0]).toMatchObject({
          kind: "storage",
          deploymentId: DEPLOYMENT,
          tenant: "storage-fixture",
          actorType: "",
          actorId: "",
          commandId: null,
          requestToken: null,
          storageByteHours: 8192,
        })
        expect((yield* usage.sampleStorage(hour)).samples).toEqual([
          { tenant: "storage-fixture", logicalBytes: 8192 },
        ])
      }),
    ))
})

describe("source state", () => {
  it("reports the oldest hour that still has an unacknowledged row", () =>
    run(
      Effect.gen(function* () {
        const usage = yield* CellUsage
        const oldest = yield* hourAgo(40)
        const next = yield* hourAgo(39)

        yield* insertAt(oldest, "oldest-1")
        yield* insertAt(next, "next-1")

        expect(yield* usage.earliestHour).toEqual(oldest)

        const page = yield* usage.sealAndPending(oldest)
        yield* usage.ack(page.events.map((event) => event.eventId))

        expect(yield* usage.earliestHour).toEqual(next)
      }),
    ))
})

describe("deployment ownership", () => {
  const foreign = (hour: DateTime.Utc, label: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* sql`
        INSERT INTO cloud_meter_cell_journal
          (deployment_id, tenant_id, actor_type, actor_id, command_id, kind, hour, recorded_at)
        VALUES ('dep_other', 'seeded', 'Seeded', ${label}, ${label}, 'command',
          ${DateTime.formatIso(hour)}::timestamptz, clock_timestamp())`
    }).pipe(Effect.orDie)

  it("refuses to start for a database another deployment owns", () =>
    run(
      Effect.gen(function* () {
        const mismatch = yield* Effect.flip(
          Effect.scoped(Layer.build(CellUsageLive({ deploymentId: "dep_other" }))),
        )
        const same = yield* Effect.scoped(Layer.build(CellUsageLive({ deploymentId: DEPLOYMENT })))

        expect(mismatch).toEqual(
          DeploymentMismatch.make({ configured: "dep_other", owner: DEPLOYMENT }),
        )
        expect(Context.get(same, CellUsage)).toBeDefined()
      }),
    ))

  it("never reads, reports or acknowledges another deployment's rows", () =>
    run(
      Effect.gen(function* () {
        const usage = yield* CellUsage
        const sql = yield* SqlClient.SqlClient
        const hour = yield* hourAgo(50)
        const later = yield* hourAgo(49)

        yield* foreign(hour, "foreign-1")
        yield* insertAt(later, "own-1")

        expect(yield* usage.earliestHour).toEqual(later)

        const page = yield* usage.sealAndPending(hour)

        expect(page.events).toEqual([])

        const ownPage = yield* usage.sealAndPending(later)
        const [other] = yield* sql<{ event_id: string }>`
          SELECT event_id FROM cloud_meter_cell_journal WHERE command_id = 'foreign-1'`
        const ownId = ownPage.events[0]!.eventId
        const missing = "00000000-0000-4000-8000-000000000000"
        const unacked = (id: string) =>
          sql<{ acked_at: Date | null }>`
            SELECT acked_at FROM cloud_meter_cell_journal WHERE event_id = ${id}::uuid`.pipe(
            Effect.map(([row]) => row!.acked_at),
          )

        expect(yield* Effect.flip(usage.ack([other!.event_id]))).toEqual(
          UnknownEvents.make({ eventIds: [other!.event_id] }),
        )
        expect(yield* Effect.flip(usage.ack([ownId, other!.event_id, missing]))).toEqual(
          UnknownEvents.make({ eventIds: [other!.event_id, missing] }),
        )
        expect(yield* unacked(other!.event_id)).toBeNull()
        expect(yield* unacked(ownId)).toBeNull()
        expect(yield* usage.ack([ownId])).toBe(1)
      }),
    ))
})

describe("atomicity with the receipt", () => {
  it("rolls the receipt and state back when the journal row cannot be written", () =>
    run(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const sql = yield* SqlClient.SqlClient
        const counter = yield* Counter.get("poisoned")

        yield* sql`CREATE OR REPLACE FUNCTION cloud_meter_test_poison() RETURNS trigger AS $$
          BEGIN
            IF NEW.actor_id = 'poisoned' THEN RAISE EXCEPTION 'journal unavailable'; END IF;
            RETURN NEW;
          END $$ LANGUAGE plpgsql`
        yield* sql`CREATE OR REPLACE TRIGGER cloud_meter_test_poison
          BEFORE INSERT ON cloud_meter_cell_journal
          FOR EACH ROW EXECUTE FUNCTION cloud_meter_test_poison()`

        const failed = yield* counter.Increment(7).pipe(Effect.exit, Effect.timeout("4 seconds"))

        yield* sql`DROP TRIGGER cloud_meter_test_poison ON cloud_meter_cell_journal`

        expect(Exit.isFailure(failed)).toBe(true)
        expect(yield* test.receiptsFor(counter.ref, "Increment")).toBe(0)
        expect((yield* test.inspect(counter.ref)).state).toEqual({})
        expect(yield* journalOf("poisoned")).toHaveLength(0)
        expect(yield* counter.Increment(7)).toBe(7)
        expect(yield* journalOf("poisoned")).toHaveLength(1)
      }),
    ))
})

describe("a runtime without a host hook", () => {
  const Bump = Actor.command("Bump", { payload: Schema.Int, success: Schema.Int })
  const Watched = Actor.query("Watched", { success: Schema.Int, watch: true })

  let checks = 0

  const Audited = Actor.make("AuditedCounter", {
    key: Schema.String,
    state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
    api: { Bump, Watched },
    access: () =>
      Effect.sync(() => {
        checks += 1
        return true
      }),
  })

  const AuditedLive = Audited.toLayer(
    Effect.succeed({
      Bump: Effect.fnUntraced(function* (amount: number) {
        const turn = yield* Audited.Turn
        yield* turn.state.set({ count: turn.state.count + amount })

        return turn.state.count
      }),
    }),
  )

  const AuditedReads = Audited.toQueryLayer(
    Effect.succeed({
      Watched: Effect.fnUntraced(function* () {
        return (yield* Audited.Read).state.count
      }),
    }),
  )

  interface Calls {
    commands: number
    reads: number
  }

  const counting = (calls: Calls): UsageAccountingService => ({
    commands: () => Effect.sync(() => void (calls.commands += 1)),
    read: () => Effect.sync(() => void (calls.reads += 1)),
  })

  /**
   * Commits a command, replays it, answers a tokened query and opens a
   * tokened watch on a fresh database, with `hook` provided when given, and
   * counts the actor's access checks meanwhile.
   */
  const probe = (hook: UsageAccountingService | undefined) =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          Layer.unwrap(
            Effect.gen(function* () {
              const test = ActorTest.layer({ database: yield* database })

              return Layer.mergeAll(AuditedLive, AuditedReads).pipe(
                Layer.provideMerge(
                  hook === undefined
                    ? test
                    : test.pipe(Layer.provide(Layer.succeed(UsageAccounting, hook))),
                ),
              )
            }),
          ).pipe(Layer.provide(BunCrypto.layer)),
        )

        return yield* Effect.gen(function* () {
          const audited = yield* Audited.get("probe")
          const bump = audited.Bump(1)

          yield* bump
          yield* bump
          checks = 0
          yield* Effect.gen(function* () {
            return yield* (yield* Audited.get("probe")).Watched()
          }).pipe(tokened("probe-query"))
          yield* Effect.gen(function* () {
            return yield* (yield* Audited.get("probe")).Watched.watch().pipe(
              Stream.take(1),
              Stream.runCollect,
            )
          }).pipe(tokened("probe-watch"))

          return checks
        }).pipe(Effect.provideContext(context))
      }),
    ).pipe(Effect.orDie)

  it("never invokes the default hook, and skips the watch's extra access check that a provided no-op hook pays", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fallback = Context.getUnsafe(Context.empty(), UsageAccounting) as {
          -readonly [K in keyof UsageAccountingService]: UsageAccountingService[K]
        }
        const original = { ...fallback }
        const defaulted: Calls = { commands: 0, reads: 0 }
        const hooked: Calls = { commands: 0, reads: 0 }

        Object.assign(fallback, counting(defaulted))
        const unhookedChecks = yield* probe(undefined).pipe(
          Effect.ensuring(Effect.sync(() => Object.assign(fallback, original))),
        )
        const hookedChecks = yield* probe(counting(hooked))

        expect(defaulted).toEqual({ commands: 0, reads: 0 })
        expect(hooked).toEqual({ commands: 1, reads: 2 })
        expect(hookedChecks - unhookedChecks).toBe(1)
      }),
    ))
})

describe("a persisted current-hour storage sample", () => {
  const setup = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ hour: Date }>`
      SELECT date_trunc('hour', clock_timestamp(), 'UTC') AS hour`

    yield* sql`CREATE TABLE meter_probe (tenant_id text NOT NULL, routing_key bigint NOT NULL, body text)`
    yield* sql`INSERT INTO meter_probe VALUES ('alpha', 1, repeat('a', 64))`

    return DateTime.fromDateUnsafe(row!.hour)
  }).pipe(Effect.orDie)

  it("is returned without scanning tenant tables again, even while one is locked or has a new tenant", () =>
    runEmpty(
      Effect.gen(function* () {
        const usage = yield* CellUsage
        const sql = yield* SqlClient.SqlClient
        const hour = yield* setup
        const first = yield* usage.sampleStorage(hour)

        expect(first.samples.map(({ tenant }) => tenant)).toEqual(["alpha"])

        yield* sql`INSERT INTO meter_probe VALUES ('beta', 2, repeat('b', 512))`
        const locked = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const holder = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`LOCK TABLE meter_probe IN ACCESS EXCLUSIVE MODE`
              yield* Deferred.succeed(locked, undefined)
              yield* Deferred.await(release)
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(locked)

        const again = yield* usage
          .sampleStorage(hour)
          .pipe(
            Effect.timeoutOption("2 seconds"),
            Effect.ensuring(Deferred.succeed(release, undefined)),
          )
        yield* Fiber.join(holder)

        expect(Option.getOrUndefined(again)?.samples).toEqual(first.samples)
        expect((yield* usage.sampleStorage(hour)).samples).toEqual(first.samples)

        const [stored] = yield* sql<{ total: number }>`
          SELECT count(*)::int AS total FROM cloud_meter_cell_journal WHERE kind = 'storage'`

        expect(stored!.total).toBe(1)
      }),
    ))

  it("records zero for a previously sampled tenant whose rows were all deleted", () =>
    runEmpty(
      Effect.gen(function* () {
        const usage = yield* CellUsage
        const sql = yield* SqlClient.SqlClient
        const hour = yield* setup
        const earlier = (hours: number) => DateTime.formatIso(DateTime.subtract(hour, { hours }))
        const fixture = (deployment: string, tenant: string, hours: number, bytes: number) =>
          sql`
            INSERT INTO cloud_meter_cell_journal
              (deployment_id, tenant_id, actor_type, actor_id, kind, hour, recorded_at, storage_byte_hours)
            VALUES (${deployment}, ${tenant}, '', '', 'storage', ${earlier(hours)}::timestamptz,
              clock_timestamp(), ${bytes})`

        yield* sql`INSERT INTO meter_probe VALUES ('beta', 2, repeat('b', 512))`
        yield* fixture(DEPLOYMENT, "beta", 2, 600_000_000)
        yield* fixture(DEPLOYMENT, "eta", 3, 5000)
        yield* fixture(DEPLOYMENT, "eta", 2, 0)
        yield* fixture("dep_other", "other", 2, 999)
        yield* sql`DELETE FROM meter_probe WHERE tenant_id = 'beta'`

        const sample = yield* usage.sampleStorage(hour)
        const alpha = sample.samples.find(({ tenant }) => tenant === "alpha")

        expect(sample.samples.map(({ tenant }) => tenant)).toEqual(["alpha", "beta"])
        expect(alpha!.logicalBytes).toBeGreaterThan(0)
        expect(sample.samples.find(({ tenant }) => tenant === "beta")).toEqual({
          tenant: "beta",
          logicalBytes: 0,
        })

        yield* sql`INSERT INTO meter_probe VALUES ('beta', 3, repeat('b', 512))`
        expect((yield* usage.sampleStorage(hour)).samples).toEqual(sample.samples)

        const rows = yield* sql<{ deployment_id: string; tenant_id: string; bytes: string }>`
          SELECT deployment_id, tenant_id, storage_byte_hours::text AS bytes
          FROM cloud_meter_cell_journal
          WHERE kind = 'storage' AND hour = ${DateTime.formatIso(hour)}::timestamptz
          ORDER BY tenant_id`

        expect(
          rows.map(({ deployment_id, tenant_id, bytes }) => [deployment_id, tenant_id, bytes]),
        ).toEqual([
          [DEPLOYMENT, "alpha", String(alpha!.logicalBytes)],
          [DEPLOYMENT, "beta", "0"],
        ])
      }),
    ))

  it("still refuses a role that cannot see every attributed row", () =>
    runEmpty(
      Effect.scoped(
        Effect.gen(function* () {
          const usage = yield* CellUsage
          const sql = yield* SqlClient.SqlClient
          const hour = yield* setup

          yield* usage.sampleStorage(hour)
          const [named] = yield* sql<{ name: string }>`SELECT current_database() AS name`
          const role = `meter_probe_${named!.name}`
          yield* Effect.acquireRelease(
            sql`CREATE ROLE ${sql(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
            () =>
              sql`DROP OWNED BY ${sql(role)}`.pipe(
                Effect.andThen(sql`DROP ROLE ${sql(role)}`),
                Effect.orDie,
              ),
          )
          yield* sql`GRANT USAGE ON SCHEMA public TO ${sql(role)}`
          yield* sql`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${sql(role)}`
          yield* sql`ALTER TABLE meter_probe ENABLE ROW LEVEL SECURITY`

          const denied = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SET LOCAL ROLE ${sql(role)}`
              return yield* Effect.flip(usage.sampleStorage(hour))
            }),
          )

          expect(denied).toEqual(StorageNotObservable.make({ tables: ["meter_probe"] }))
        }),
      ).pipe(Effect.orDie),
    ))
})
