import { BunCrypto } from "@effect/platform-bun"
import { pgTable, text } from "drizzle-orm/pg-core"
import {
  Config,
  Context,
  Crypto,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Redacted,
  Schedule,
  Schema,
} from "effect"
import { RunnerAddress, ShardId, ShardingConfig } from "effect/cluster"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { Actor, Fleet } from "../../index.ts"
import { Database } from "../layer.ts"
import { maintain } from "../fleet/maintainer.ts"
import { groupLock } from "../jobs/attempt.ts"
import { sweep } from "../storage/retention.ts"
import { coordinatedRunnerStorage, tableShardLease } from "../topology/locks.ts"
import { acceptWorkflows } from "../workflows/compatibility.ts"
import { Coordination } from "./coordination.ts"
import { migrate } from "./migrations.ts"

const Work = Actor.workflow("Work", { success: Schema.String })
const actor = { name: "Coordinated", workflows: [Work] }

const fleetSource = Actor.table(
  pgTable("coordination_fleet_source", {
    id: text("id").primaryKey(),
    category: text("category").notNull(),
  }),
)
const fleetView = Fleet.view("CoordinatedFleet", {
  from: fleetSource,
  groupBy: ["category"],
  select: { count: Fleet.count() },
})
const views = [{ view: fleetView, sourceSchema: "public", derivedSchema: "public" }]

const policy = {
  actorType: actor.name,
  keepReceiptsMs: 0,
  keepEventsMs: 0,
  holdEventsMs: 0,
  deliveryMs: 0,
  keepWorkflowsMs: 0,
  workflows: false,
}

/** Three independent databases reject accidental coordination through either runner's data pool. */
const databases = Effect.gen(function* () {
  const url = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const suffix = (yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")
  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: url.href })),
    (pool) => Effect.promise(() => pool.end()),
  )

  const opened = yield* Effect.forEach(["control", "a", "b"], (part) =>
    Effect.gen(function* () {
      const name = `coordination_${part}_${suffix}`
      yield* Effect.acquireRelease(
        Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
        () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
      )
      const connection = new URL(url)
      connection.pathname = `/${name}`
      const pool = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: connection.href })),
        (db) => Effect.promise(() => db.end()),
      )
      return { name, url: Redacted.make(connection.href), pool }
    }),
  )

  const control = opened[0]!
  const shards = yield* Effect.forEach(opened.slice(1), (db) =>
    Effect.gen(function* () {
      const services = yield* Layer.build(
        Database.postgres({ url: db.url, coordination: { url: control.url } }),
      )
      yield* Effect.provide(migrate, services)
      yield* Effect.promise(() =>
        db.pool.query(`INSERT INTO actor_generations
          (routing_key, tenant_id, actor_type, actor_id)
          VALUES (42, 'tenant', 'Coordinated', 'one')`),
      )
      yield* Effect.promise(() =>
        db.pool.query(`INSERT INTO actor_receipts
          (routing_key, tenant_id, actor_type, actor_id, command_id, command,
            payload_hash, caller_key, outcome, expires_at_ms)
          VALUES (42, 'tenant', 'Coordinated', 'one', 'expired', 'Do', '', '', '{}', 0)`),
      )
      return { ...db, services }
    }),
  )
  return { control, a: shards[0]!, b: shards[1]! }
})

/** Waits for database-observed contention rather than assuming a scheduled fiber has reached its lock. */
const blocked = (pool: Pool, name: string) =>
  Effect.promise(() =>
    pool.query("SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'", [
      name,
    ]),
  ).pipe(
    Effect.flatMap((rows) => (rows.rowCount === 1 ? Effect.void : Effect.fail("not blocked"))),
    Effect.retry({ times: 120, schedule: Schedule.spaced("25 millis") }),
  )

/** A table lock holds the first runner inside real SQL while the other tries the same resource on another database. */
const gate = (pool: Pool, table: string) =>
  Effect.gen(function* () {
    const connection = yield* Effect.acquireRelease(
      Effect.promise(() => pool.connect()),
      (client) =>
        Effect.promise(() => client.query("ROLLBACK")).pipe(
          Effect.ensuring(Effect.sync(() => client.release())),
        ),
    )
    yield* Effect.promise(() => connection.query("BEGIN"))
    yield* Effect.promise(() => connection.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`))
    return { release: Effect.promise(() => connection.query("ROLLBACK")) }
  })

describe("authoritative coordination across data databases", () => {
  const runtime = ManagedRuntime.make(BunCrypto.layer)
  afterAll(() => runtime.dispose())

  for (const interrupt of [false, true]) {
    it(`serializes retention batches across shards and releases on ${interrupt ? "interruption" : "commit"}`, () =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { control, a, b } = yield* databases
            const { release } = yield* gate(a.pool, "actor_receipts")
            const first = yield* Effect.forkChild(Effect.provide(sweep([policy], 1), a.services))
            yield* blocked(a.pool, a.name)
            const second = yield* Effect.forkChild(Effect.provide(sweep([policy], 1), b.services))
            yield* blocked(control.pool, control.name).pipe(Effect.onError(() => release))
            expect(
              (yield* Effect.promise(() => b.pool.query("SELECT * FROM actor_receipts"))).rowCount,
            ).toBe(1)

            if (interrupt) {
              const stopping = yield* Effect.forkChild(Fiber.interrupt(first))
              yield* Effect.yieldNow
              yield* release
              yield* Fiber.join(stopping)
            } else {
              yield* release
              expect((yield* Fiber.join(first)).receipts).toBe(1)
            }

            expect((yield* Fiber.join(second)).receipts).toBe(1)
            expect(
              (yield* Effect.promise(() => b.pool.query("SELECT * FROM actor_receipts"))).rowCount,
            ).toBe(0)
            expect(
              (yield* Effect.promise(() => a.pool.query("SELECT * FROM actor_receipts"))).rowCount,
            ).toBe(interrupt ? 1 : 0)
          }),
        ),
      ))

    it(`serializes workflow acceptance across shards and releases on ${interrupt ? "interruption" : "commit"}`, () =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { control, a, b } = yield* databases
            const { release } = yield* gate(a.pool, "actor_workflow_manifests")
            const first = yield* Effect.forkChild(
              Effect.provide(acceptWorkflows(actor), a.services),
            )
            yield* blocked(a.pool, a.name)
            const second = yield* Effect.forkChild(
              Effect.provide(acceptWorkflows(actor), b.services),
            )
            yield* blocked(control.pool, control.name).pipe(Effect.onError(() => release))
            expect(
              (yield* Effect.promise(() => b.pool.query("SELECT * FROM actor_workflow_manifests")))
                .rowCount,
            ).toBe(0)

            if (interrupt) {
              const stopping = yield* Effect.forkChild(Fiber.interrupt(first))
              yield* Effect.yieldNow
              yield* release
              yield* Fiber.join(stopping)
            } else {
              yield* release
              expect((yield* Fiber.join(first)).checked).toBe(true)
            }

            expect((yield* Fiber.join(second)).checked).toBe(true)
            expect(
              (yield* Effect.promise(() => b.pool.query("SELECT * FROM actor_workflow_manifests")))
                .rowCount,
            ).toBe(1)
            expect(
              (yield* Effect.promise(() => a.pool.query("SELECT * FROM actor_workflow_manifests")))
                .rowCount,
            ).toBe(interrupt ? 0 : 1)
          }),
        ),
      ))
  }

  it("keeps the data transaction fenced when the coordination session is lost", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { control, a } = yield* databases
          const { release } = yield* gate(a.pool, "actor_receipts")
          const first = yield* Effect.forkChild(
            Effect.exit(Effect.provide(sweep([policy], 1), a.services)),
          )
          yield* blocked(a.pool, a.name)
          const replacement = yield* Layer.build(
            Database.postgres({
              url: a.url,
              coordination: { url: control.url },
            }),
          )
          const killed = yield* Effect.promise(() =>
            control.pool.query(
              `SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity
              WHERE datname = $1 AND xact_start IS NOT NULL AND pid <> pg_backend_pid()`,
              [control.name],
            ),
          )
          expect(killed.rowCount).toBe(1)
          expect(killed.rows[0].killed).toBe(true)
          const second = yield* Effect.forkChild(Effect.provide(sweep([policy], 1), replacement))
          yield* Effect.promise(() =>
            a.pool.query(
              `SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'
          AND query LIKE '%INSERT INTO actor_coordination%'`,
              [a.name],
            ),
          ).pipe(
            Effect.flatMap((rows) =>
              rows.rowCount === 1 ? Effect.void : Effect.fail("data fence not held"),
            ),
            Effect.retry({ times: 120, schedule: Schedule.spaced("25 millis") }),
            Effect.onError(() => release),
          )
          yield* release
          expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true)
          expect((yield* Fiber.join(second)).receipts).toBe(1)
          expect(
            (yield* Effect.promise(() => a.pool.query("SELECT * FROM actor_receipts"))).rowCount,
          ).toBe(0)
        }),
      ),
    ))

  it("does not self-deadlock when an independent coordination pool points to the data database", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { a } = yield* databases
          const services = yield* Layer.build(
            Database.postgres({
              url: a.url,
              coordination: { url: a.url },
              startupParameters: { statement_timeout: "3000" },
            }),
          )
          expect(
            (yield* Effect.provide(sweep([policy], 1), services).pipe(Effect.timeout("5 seconds")))
              .receipts,
          ).toBe(1)
          expect(
            (yield* Effect.provide(acceptWorkflows(actor), services).pipe(
              Effect.timeout("5 seconds"),
            )).checked,
          ).toBe(true)
          expect(
            (yield* Effect.promise(() =>
              a.pool.query("SELECT resource FROM actor_coordination ORDER BY resource"),
            )).rows.map((row) => row.resource),
          ).toEqual([
            "akter/retention/Coordinated",
            "akter/workflows/Coordinated",
            "local/akter/retention/Coordinated",
            "local/akter/workflows/Coordinated",
          ])
        }),
      ),
    ))

  for (const tableLocks of [false, true]) {
    it(`shares Cluster ${tableLocks ? "table leases" : "session locks"} and fails over without touching data-shard lock tables`, () =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { control, a, b } = yield* databases
            const storage = (services: typeof a.services) =>
              coordinatedRunnerStorage.pipe(
                Effect.provide(services),
                Effect.provideService(ShardingConfig.ShardingConfig, {
                  ...ShardingConfig.defaults,
                  shardLockDisableAdvisory: tableLocks,
                }),
              )
            const first = yield* storage(a.services)
            const second = yield* storage(b.services)
            const addressA = RunnerAddress.make("first", 1)
            const addressB = RunnerAddress.make("second", 2)
            const shards = [ShardId.make("default", 1), ShardId.make("default", 2)]

            expect(yield* first.acquire(addressA, shards)).toEqual(shards)
            expect(yield* second.acquire(addressB, shards)).toEqual([])
            if (tableLocks) {
              const lease = tableShardLease({
                sql: Context.get(a.services, Coordination)!,
                address: addressA,
                expiration: Duration.seconds(30),
              })
              expect(yield* lease.holds("default:1")).toBe(true)
              yield* first.releaseAll(addressA)
              expect(yield* lease.holds("default:1")).toBe(false)
            } else yield* first.releaseAll(addressA)
            expect(yield* second.acquire(addressB, shards)).toEqual(shards)

            for (const data of [a, b])
              expect(
                (yield* Effect.promise(() =>
                  data.pool.query("SELECT to_regclass('cluster_locks') AS name"),
                )).rows[0].name,
              ).toBeNull()
            expect(
              (yield* Effect.promise(() =>
                control.pool.query("SELECT to_regclass('cluster_runners') AS name"),
              )).rows[0].name,
            ).toBe("cluster_runners")
          }),
        ),
      ))
  }

  it("keeps the fleet maintainer lock on the authority and releases it on shutdown", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { control, a, b } = yield* databases
          const first = yield* Effect.forkChild(Effect.provide(maintain(views), a.services))
          yield* Effect.promise(() =>
            control.pool.query(
              "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND objid = (hashtext('akter/fleet')::bigint & 4294967295) AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
            ),
          ).pipe(
            Effect.flatMap((rows) => (rows.rowCount === 1 ? Effect.void : Effect.fail("not held"))),
            Effect.retry({ times: 120, schedule: Schedule.spaced("25 millis") }),
          )
          const second = yield* Effect.forkChild(Effect.provide(maintain(views), b.services))
          const probe = yield* Effect.acquireRelease(
            Effect.promise(() => control.pool.connect()),
            (connection) => Effect.sync(() => connection.release()),
          )
          expect(
            (yield* Effect.promise(() =>
              probe.query("SELECT pg_try_advisory_lock(hashtext('akter/fleet')) AS held"),
            )).rows[0].held,
          ).toBe(false)
          const lockQuery = `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted
            AND objid = (hashtext('akter/fleet')::bigint & 4294967295)
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`
          const owner = (yield* Effect.promise(() => control.pool.query(lockQuery))).rows[0].pid
          yield* Fiber.interrupt(first)
          yield* Effect.promise(() => control.pool.query(lockQuery)).pipe(
            Effect.flatMap((locks) =>
              locks.rowCount === 1 && locks.rows[0].pid !== owner
                ? Effect.void
                : Effect.fail("no fleet takeover"),
            ),
            Effect.retry({ times: 160, schedule: Schedule.spaced("25 millis") }),
          )
          yield* Fiber.interrupt(second)
          expect(
            (yield* Effect.promise(() =>
              probe.query("SELECT pg_try_advisory_lock(hashtext('akter/fleet')) AS held"),
            )).rows[0].held,
          ).toBe(true)
          yield* Effect.promise(() =>
            probe.query("SELECT pg_advisory_unlock(hashtext('akter/fleet'))"),
          )
        }),
      ),
    ))

  it("capped jobs wait for their actor's shard-local generation lock", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { a } = yield* databases
          const { release } = yield* gate(a.pool, "actor_generations")
          const sql = Context.get(a.services, SqlClient.SqlClient)
          const locked = yield* Effect.forkChild(
            sql.withTransaction(
              groupLock({
                sql,
                group: {
                  routing_key: "42",
                  tenant_id: "tenant",
                  actor_type: actor.name,
                  actor_id: "one",
                  command: "Work",
                },
              }),
            ),
          )
          yield* blocked(a.pool, a.name)
          yield* release
          expect(yield* Fiber.join(locked)).toHaveLength(1)
        }),
      ),
    ))
})
