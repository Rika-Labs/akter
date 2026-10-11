import { BunCrypto, BunServices } from "@effect/platform-bun"
import { layerClientProtocol, layerSocketServer } from "@effect/platform-bun/BunClusterSocket"
import { PgClient } from "@effect/sql-pg"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Redacted,
  Schema,
  Scope,
  Stream,
  Schedule,
} from "effect"
import { SqlClient } from "effect/sql"
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest"
import { Actors, Database, Runner } from "../../../../../packages/akter/src/runtime/index.ts"
import { Actor, Actors as ActorClient } from "../../../../../packages/akter/src/index.ts"
import { TurnHooks } from "../../../../../packages/akter/src/runtime/turn/hooks.ts"
import { WarmTurnFastPath } from "../../../../../packages/akter/src/runtime/turn/execute.ts"
import {
  coordinationLayer,
  Coordination,
} from "../../../../../packages/akter/src/runtime/database/coordination.ts"
import { migrate, migrator } from "../../../../../packages/akter/src/runtime/database/migrations.ts"
import { ActorRef } from "../../../../../packages/akter/src/identity/caller.ts"
import {
  fence,
  type ActivationCache,
} from "../../../../../packages/akter/src/runtime/storage/generation.ts"
import { ColdStorage } from "../../../../../packages/akter/src/runtime/storage/cold-storage.ts"
import { OrdersByStatus } from "../fleet.ts"
import { endpoint, freePort, until } from "../crash/drills/failover.ts"
import { processTopology } from "../crash/drills/production.ts"
import { decompress } from "../../../../../packages/akter/src/runtime/storage/codec.ts"
import { poolServing } from "./pooling-serving.ts"
import { transactionPooler } from "./pooling.ts"

const wiring = Effect.gen(function* () {
  return Runner.socket({
    address: { host: "127.0.0.1", port: yield* freePort },
    transport: Layer.merge(layerSocketServer, layerClientProtocol),
    shardsPerGroup: 4,
    shardLockExpiration: "3 seconds",
    shardLockRefreshInterval: "500 millis",
    refreshAssignmentsInterval: "100 millis",
    entityTerminationTimeout: "1 second",
  })
})

describe("explicit transaction pooling through pinned PgBouncer", () => {
  const runtime = ManagedRuntime.make(Layer.merge(BunCrypto.layer, BunServices.layer))
  let fixture: Effect.Success<ReturnType<typeof transactionPooler>>
  let fixtureScope: Scope.Closeable
  beforeEach(() => {
    fixtureScope = Scope.makeUnsafe()
    return runtime.runPromise(
      transactionPooler().pipe(
        Scope.provide(fixtureScope),
        Effect.tap((value) =>
          Effect.sync(() => {
            fixture = value
          }),
        ),
      ),
    )
  }, 60_000)
  afterEach(() => runtime.runPromise(Scope.close(fixtureScope, Exit.void)), 60_000)
  afterAll(() => runtime.dispose())

  it(
    "refuses session-dependent configurations before migrations or registration",
    () =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { url, direct } = fixture
            expect(() =>
              Database.postgres({ url, pooling: "transaction", replica: { url } }),
            ).toThrow("does not support replica")
            expect(() =>
              Database.postgres({ url, pooling: "transaction", coordination: { url } }),
            ).toThrow("does not support replica")
            const exit = yield* Layer.build(
              Actors.layer().pipe(
                Layer.provide(Database.postgres({ url, pooling: "transaction" })),
              ),
            ).pipe(Effect.exit)
            expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain(
              "requires Runner.socket",
            )
            for (const options of [
              { coldStorage: { store: ColdStorage.memory(), backupRetention: "1 day" as const } },
              { fleet: [OrdersByStatus] },
            ]) {
              const refused = yield* Layer.build(
                Actors.layer(options).pipe(
                  Layer.provide(yield* wiring),
                  Layer.provide(Database.postgres({ url, pooling: "transaction" })),
                ),
              ).pipe(Effect.exit)
              expect(Exit.isFailure(refused) && String(Cause.squash(refused.cause))).toContain(
                "does not support coldStorage or fleet",
              )
            }
            expect(
              (yield* Effect.promise(() =>
                direct.query("SELECT to_regclass('actor_migrations')::text AS name"),
              )).rows,
            ).toEqual([{ name: null }])
          }),
        ),
      ),
    30_000,
  )

  it(
    "reassigns backend PIDs across three logical clients and preserves savepoints, RLS, aborted COMMIT and cancellation",
    () =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { url, direct, proxy, name } = fixture
            yield* Effect.promise(() => proxy.query("SET default_pool_size = 2"))
            yield* Effect.promise(() => proxy.query("SET max_db_connections = 2"))
            expect((yield* Effect.promise(() => proxy.query("SHOW VERSION"))).rows).toEqual([
              { version: "PgBouncer 1.25.2" },
            ])
            const clients = yield* Effect.forEach([0, 1, 2], () =>
              Layer.build(
                Database.postgres({
                  url,
                  pooling: "transaction",
                  prepare: true,
                  maxConnections: 1,
                  offTurnConnections: 1,
                  queryConnections: 1,
                }),
              ).pipe(Effect.map((context) => Context.get(context, PgClient.PgClient))),
            )
            expect(clients.every((client) => client.config.prepare === false)).toBe(true)
            const connections = yield* Effect.forEach(clients, (client) => client.reserve)
            const [a, b, c] = connections
            const execute = (connection: typeof a, text: string) =>
              connection!.execute(text, [], undefined)
            const pid = (connection: typeof a) =>
              execute(connection, "SELECT pg_backend_pid() AS pid").pipe(
                Effect.map((rows) => (rows[0] as { pid: number }).pid),
              )
            yield* execute(a, "BEGIN")
            const original = yield* pid(a)
            yield* execute(b, "BEGIN")
            const alternate = yield* pid(b)
            expect(alternate).not.toBe(original)
            yield* execute(a, "COMMIT")
            yield* execute(c, "BEGIN")
            expect(yield* pid(c)).toBe(original)
            yield* execute(b, "COMMIT")
            yield* execute(a, "BEGIN")
            expect(yield* pid(a)).toBe(alternate)
            expect(yield* execute(a, "SELECT name FROM pg_prepared_statements")).toEqual([])
            yield* execute(a, "COMMIT")
            yield* execute(c, "COMMIT")
            const logical = (yield* Effect.promise(() => proxy.query("SHOW CLIENTS"))).rows.filter(
              (row: { database: string }) => row.database === name,
            )
            const physical = (yield* Effect.promise(() =>
              direct.query(
                "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid = ANY($1::int[])",
                [[original, alternate]],
              ),
            )).rows
            const servers = (yield* Effect.promise(() => proxy.query("SHOW SERVERS"))).rows.filter(
              (row: { database: string }) => row.database === name,
            )
            expect(logical).toHaveLength(3)
            expect(servers).toHaveLength(2)
            expect(
              new Set(servers.map((row: { remote_pid: number }) => Number(row.remote_pid))),
            ).toEqual(new Set([original, alternate]))
            expect(physical).toHaveLength(2)
            yield* Effect.promise(() =>
              direct.query(`CREATE TABLE pool_tenants (tenant text, amount integer);
          INSERT INTO pool_tenants VALUES ('alpha', 17), ('beta', 43);
          ALTER TABLE pool_tenants ENABLE ROW LEVEL SECURITY;
          CREATE POLICY tenant ON pool_tenants USING (tenant = current_setting('durable.tenant', true));
          CREATE TABLE pool_atomic (amount integer)`),
            )
            yield* execute(a, "BEGIN")
            yield* execute(a, "SET LOCAL ROLE pg_read_all_data")
            yield* execute(a, "SELECT set_config('durable.tenant', 'alpha', true)")
            expect(yield* execute(a, "SELECT amount FROM pool_tenants")).toEqual([{ amount: 17 }])
            yield* execute(a, "COMMIT")
            yield* execute(b, "BEGIN")
            yield* execute(b, "SET LOCAL ROLE pg_read_all_data")
            expect(yield* execute(b, "SELECT amount FROM pool_tenants")).toEqual([])
            yield* execute(b, "SELECT set_config('durable.tenant', 'beta', true)")
            expect(yield* execute(b, "SELECT amount FROM pool_tenants")).toEqual([{ amount: 43 }])
            yield* execute(b, "ROLLBACK")
            yield* execute(c, "BEGIN")
            yield* execute(c, "SAVEPOINT nested")
            expect(Exit.isFailure(yield* execute(c, "SELECT 1 / 0").pipe(Effect.exit))).toBe(true)
            yield* execute(c, "ROLLBACK TO SAVEPOINT nested")
            yield* execute(c, "RELEASE SAVEPOINT nested")
            yield* execute(c, "INSERT INTO pool_atomic VALUES (23)")
            yield* execute(c, "COMMIT")
            expect(
              (yield* Effect.promise(() => direct.query("SELECT * FROM pool_atomic"))).rows,
            ).toEqual([{ amount: 23 }])
          }),
        ),
      ),
    30_000,
  )

  it(
    "rolls back aborted commits and routes cancellation without cancelling the next backend borrower",
    () =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { url, direct } = fixture
            const context = yield* Layer.build(
              Database.postgres({ url, pooling: "transaction", offTurnConnections: 1 }),
            )
            const sql = Context.get(context, SqlClient.SqlClient)
            yield* sql`CREATE TABLE pool_atomic (amount integer)`
            const aborted = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql`INSERT INTO pool_atomic VALUES (91)`
                  yield* sql`SELECT 1 / 0`.pipe(Effect.ignore)
                }),
              )
              .pipe(Effect.exit)
            expect(Exit.isFailure(aborted) && String(Cause.squash(aborted.cause))).toContain(
              "COMMIT rolled back",
            )
            expect(yield* sql`SELECT * FROM pool_atomic`).toEqual([])
            const cancelled = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql`INSERT INTO pool_atomic VALUES (71)`
                  yield* sql`SELECT pg_sleep(30) AS pooler_cancel_probe`
                }),
              )
              .pipe(Effect.forkScoped)
            yield* Effect.tryPromise(() =>
              direct.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND query = 'SELECT pg_sleep(30) AS pooler_cancel_probe'",
              ),
            ).pipe(
              Effect.flatMap((result) =>
                result.rowCount === 1 ? Effect.void : Effect.fail("not running"),
              ),
              Effect.retry({ times: 100, schedule: Schedule.spaced("10 millis") }),
            )
            yield* Fiber.interrupt(cancelled)
            expect(
              (yield* Effect.promise(() =>
                direct.query(
                  "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND query = 'SELECT pg_sleep(30) AS pooler_cancel_probe'",
                ),
              )).rows,
            ).toEqual([])
            expect(yield* sql`SELECT * FROM pool_atomic`).toEqual([])
            expect(yield* sql`SELECT 37 AS value`).toEqual([{ value: 37 }])
          }).pipe(Effect.timeout("10 seconds")),
        ),
      ),
    30_000,
  )

  it(
    "keeps a closing reservation checked out through stream cleanup and refuses a late statement",
    () =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { url } = fixture
            const context = yield* Layer.build(
              Database.postgres({ url, pooling: "transaction", offTurnConnections: 1 }),
            )
            const sql = Context.get(context, SqlClient.SqlClient)
            const held = yield* Scope.fork(yield* Effect.scope)
            const connection = yield* sql.reserve.pipe(Scope.provide(held))
            const started = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const reading = yield* connection
              .executeStream("SELECT 17 AS value", [], undefined)
              .pipe(
                Stream.tap(() =>
                  Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
                ),
                Stream.runCollect,
                Effect.forkScoped,
              )
            yield* Deferred.await(started)
            const closing = yield* Scope.close(held, Exit.void).pipe(
              Effect.forkScoped({ startImmediately: true }),
            )
            expect(closing.pollUnsafe()).toBeUndefined()
            const queued = yield* sql`SELECT 43 AS value`.pipe(
              Effect.forkScoped({ startImmediately: true }),
            )
            expect(queued.pollUnsafe()).toBeUndefined()
            yield* Deferred.succeed(release, undefined)
            expect(yield* Fiber.join(reading)).toEqual([{ value: 17 }])
            yield* Fiber.join(closing)
            expect(yield* Fiber.join(queued)).toEqual([{ value: 43 }])
            const late = yield* connection
              .execute("SELECT 91 AS value", [], undefined)
              .pipe(Effect.exit)
            expect(Exit.isFailure(late) && Exit.hasInterrupts(late)).toBe(true)
          }).pipe(Effect.timeout("5 seconds")),
        ),
      ),
    30_000,
  )

  it(
    "serializes six public socket startups on an empty database with only three backend sessions",
    () =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { url, direct, proxy, name } = fixture
            yield* Effect.forEach(
              [0, 1, 2, 3, 4, 5],
              () =>
                Effect.gen(function* () {
                  yield* Layer.build(
                    Actors.layer().pipe(
                      Layer.provide(yield* wiring),
                      Layer.provide(
                        Database.postgres({
                          url,
                          pooling: "transaction",
                          preset: "low-connection",
                        }),
                      ),
                    ),
                  )
                }),
              { concurrency: "unbounded" },
            )
            yield* until(
              Effect.promise(() =>
                direct.query("SELECT count(*)::int AS count FROM cluster_runners"),
              ).pipe(Effect.map((result) => result.rows[0].count === 6)),
              "all six asynchronous registrations",
              "15 seconds",
            )
            expect(
              (yield* Effect.promise(() =>
                direct.query("SELECT count(*)::int AS count FROM cluster_runners"),
              )).rows,
            ).toEqual([{ count: 6 }])
            expect(
              (yield* Effect.promise(() => proxy.query("SHOW CLIENTS"))).rows.filter(
                (row: { database: string }) => row.database === name,
              ).length,
            ).toBeGreaterThan(3)
            expect(
              (yield* Effect.promise(() => proxy.query("SHOW SERVERS"))).rows.filter(
                (row: { database: string }) => row.database === name,
              ).length,
            ).toBeLessThanOrEqual(3)
            expect(
              (yield* Effect.promise(() =>
                direct.query(
                  "SELECT migration_id::int AS id FROM actor_migrations ORDER BY migration_id",
                ),
              )).rows.map((row: { id: number }) => row.id),
            ).toEqual([
              1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 22, 23, 24, 25,
              26, 27, 29, 30, 31, 32, 33, 34, 35,
            ])
          }).pipe(Effect.timeout("20 seconds")),
        ),
      ),
    30_000,
  )

  it(
    "rolls back interrupted migration history and DDL, restarts and refuses skipped compatibility ids",
    () =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { url, direct } = fixture
            const context = yield* Layer.build(
              Database.postgres({ url, pooling: "transaction", preset: "low-connection" }),
            )
            const started = yield* Deferred.make<void>()
            const create = Effect.flatMap(
              SqlClient.SqlClient,
              (sql) => sql`CREATE TABLE pool_migrated (id integer)`,
            ).pipe(Effect.asVoid)
            const interrupted = yield* migrator({
              "0001_first": create.pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Effect.never),
              ),
            }).pipe(Effect.provide(context), Effect.forkScoped)
            yield* Deferred.await(started)
            yield* Fiber.interrupt(interrupted)
            expect(
              (yield* Effect.promise(() =>
                direct.query(
                  "SELECT to_regclass('actor_migrations')::text AS history, to_regclass('pool_migrated')::text AS migrated",
                ),
              )).rows,
            ).toEqual([{ history: null, migrated: null }])
            const record = { "0001_first": create, "0003_third": Effect.void }
            yield* migrator(record).pipe(Effect.provide(context))
            yield* migrator(record).pipe(Effect.provide(context))
            const refused = yield* migrator({ ...record, "0002_missing": Effect.void }).pipe(
              Effect.provide(context),
              Effect.exit,
            )
            expect(Exit.isFailure(refused) && String(Cause.squash(refused.cause))).toContain(
              "were never applied",
            )
            expect(
              (yield* Effect.promise(() =>
                direct.query(
                  "SELECT migration_id::int AS id FROM actor_migrations ORDER BY migration_id",
                ),
              )).rows,
            ).toEqual([{ id: 1 }, { id: 3 }])
            yield* Effect.forEach(
              [0, 1, 2],
              () =>
                Layer.build(
                  coordinationLayer({
                    ...Context.get(context, PgClient.PgClient).config,
                    maxConnections: 1,
                  }),
                ).pipe(Effect.flatMap((built) => Context.get(built, Coordination)!`SELECT 1`)),
              { concurrency: "unbounded" },
            )
            expect(
              (yield* Effect.promise(() =>
                direct.query("SELECT migration_id::int AS id FROM actor_coordination_migrations"),
              )).rows,
            ).toEqual([{ id: 1 }])
          }),
        ),
      ),
    30_000,
  )

  it(
    "serves held turns, jobs, relay, workflows, inspector and receipt replay with fewer backends than logical clients",
    () =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { url } = fixture
            yield* poolServing({
              database: Database.postgres({
                url,
                pooling: "transaction",
                preset: "low-connection",
              }),
              wiring: yield* wiring,
            })
          }),
        ),
      ),
    30_000,
  )

  it(
    "rolls back a killed owner's transaction and rejects its cached generation after takeover on another backend",
    () =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { url, direct } = fixture
            const context = yield* Layer.build(
              Database.postgres({ url, pooling: "transaction", preset: "low-connection" }),
            )
            yield* migrate.pipe(Effect.provide(context))
            const sql = Context.get(context, SqlClient.SqlClient)
            yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id, generation)
        VALUES (42, 'alpha', 'PoolFence', 'one', 1)`
            yield* sql`CREATE TABLE pool_fenced (amount integer)`
            const actor = {
              key: 42n,
              ref: ActorRef.make({ tenant: "alpha", actor: "PoolFence", id: "one" }),
            }
            const cache: ActivationCache = { generation: "1", state: new Map([["value", "17"]]) }
            const held = yield* Deferred.make<number>()
            const release = yield* Deferred.make<void>()
            const stale = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  expect(
                    yield* fence({ actor, cache, lock: "UPDATE" }).pipe(
                      Effect.provideService(SqlClient.SqlClient, sql),
                    ),
                  ).toBe(true)
                  yield* sql`INSERT INTO pool_fenced VALUES (91)`
                  const [backend] = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`
                  yield* Deferred.succeed(held, backend!.pid)
                  yield* Deferred.await(release)
                }),
              )
              .pipe(Effect.forkScoped)
            const pid = yield* Deferred.await(held)
            const takeover = yield* Effect.tryPromise(() =>
              direct.query(
                "UPDATE actor_generations SET generation = 2 WHERE routing_key = 42 AND tenant_id = 'alpha' AND actor_type = 'PoolFence' AND actor_id = 'one' RETURNING generation::text",
              ),
            ).pipe(Effect.forkScoped)
            yield* until(
              Effect.promise(() =>
                direct.query(
                  "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
                ),
              ).pipe(Effect.map((result) => result.rowCount === 1)),
              "takeover waiting for the old transaction",
              "5 seconds",
            )
            expect(
              (yield* Effect.promise(() =>
                direct.query(
                  "SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE datname = current_database() AND pid = $1",
                  [pid],
                ),
              )).rows,
            ).toEqual([{ terminated: true }])
            expect((yield* Fiber.join(takeover)).rows).toEqual([{ generation: "2" }])
            yield* Deferred.succeed(release, undefined)
            expect(Exit.isFailure(yield* Fiber.join(stale).pipe(Effect.exit))).toBe(true)
            expect(yield* sql`SELECT * FROM pool_fenced`).toEqual([])
            expect(
              yield* sql.withTransaction(
                fence({ actor, cache, lock: "UPDATE" }).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                ),
              ),
            ).toBe(false)
            expect(cache.generation).toBeUndefined()
            expect(cache.state).toBeUndefined()
            yield* sql.withTransaction(
              Effect.gen(function* () {
                expect(
                  yield* fence({
                    actor,
                    cache: { generation: "2", state: undefined },
                    lock: "UPDATE",
                  }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
                ).toBe(true)
                yield* sql`INSERT INTO pool_fenced VALUES (43)`
              }),
            )
            expect(yield* sql`SELECT * FROM pool_fenced`).toEqual([{ amount: 43 }])
          }).pipe(Effect.timeout("10 seconds")),
        ),
      ),
    30_000,
  )

  it(
    "resolves a committed turn whose pooler reply was blackholed under its original command id",
    () =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { url, port, direct } = fixture
            const proxyPort = yield* freePort
            const wire = yield* endpoint(proxyPort, port)
            const routed = new URL(Redacted.value(url))
            routed.port = String(proxyPort)
            let drop: string | undefined
            const Add = Actor.command("Add", { payload: Schema.Int, success: Schema.Int })
            const Counter = Actor.make("PoolCommit", {
              key: Schema.String,
              state: Actor.state({
                value: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
              }),
              api: { Add },
            })
            const context = yield* Layer.build(
              Counter.toLayer(
                Effect.succeed({
                  Add: Effect.fnUntraced(function* (amount: number) {
                    expect(yield* WarmTurnFastPath).toBe(false)
                    const turn = yield* Counter.Turn
                    yield* turn.state.set({ value: turn.state.value + amount })
                    return turn.state.value
                  }),
                }),
              ).pipe(
                Layer.provideMerge(
                  Actors.layer().pipe(
                    Layer.provide(yield* wiring),
                    Layer.provide(
                      Layer.succeed(TurnHooks, {
                        at: (point, request) => {
                          if (point !== "beforeCommit" || request.commandId !== drop)
                            return Effect.void
                          drop = undefined
                          return wire.hold
                        },
                      }),
                    ),
                  ),
                ),
                Layer.provideMerge(
                  Database.postgres({
                    url: Redacted.make(routed.href),
                    pooling: "transaction",
                    preset: "low-connection",
                  }),
                ),
              ),
            )
            const counter = yield* Counter.get("counter").pipe(Effect.provide(context))
            expect(yield* counter.Add(17).pipe(Effect.provide(context))).toBe(17)
            const id = yield* Effect.flatMap(ActorClient, (actors) => actors.mintCommandId).pipe(
              Effect.provide(context),
            )
            drop = id
            const attempt = yield* counter
              .Add(29)
              .pipe(Actor.commandId(id), Effect.provide(context), Effect.forkScoped)
            yield* until(
              Effect.promise(() =>
                direct.query("SELECT 1 FROM actor_receipts WHERE command_id = $1", [id]),
              ).pipe(Effect.map((result) => result.rowCount === 1)),
              "commit while its acknowledgement is withheld",
              "10 seconds",
            )
            expect(attempt.pollUnsafe()).toBeUndefined()
            yield* wire.sever
            yield* Fiber.interrupt(attempt)
            yield* wire.route(port)
            expect(
              yield* counter
                .Add(29)
                .pipe(
                  Actor.commandId(id),
                  Effect.provide(context),
                  Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }),
                ),
            ).toBe(46)
            expect(
              (yield* Effect.promise(() =>
                direct.query(
                  "SELECT count(*)::int AS count FROM actor_receipts WHERE actor_type = 'PoolCommit'",
                ),
              )).rows,
            ).toEqual([{ count: 2 }])
            expect(yield* counter.Add(5).pipe(Effect.provide(context))).toBe(51)
          }),
        ),
      ),
    30_000,
  )

  it(
    "recovers table ownership after process death, backend termination, a pooler blackhole and pooler death without losing acknowledged work",
    () =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { url, directUrl, direct, proxy, proxyErrors, docker, id, name, port } = fixture
            const { spawn, query, all } = yield* processTopology(undefined, {
              url,
              observer: directUrl,
            })
            const events = query<{ value: Uint8Array; sequence: string }>(
              "SELECT value, sequence::text FROM actor_events WHERE actor_type = 'DrillBeacon' ORDER BY actor_events.sequence",
            ).pipe(
              Effect.flatMap((rows) =>
                Effect.forEach(rows, ({ value, sequence }) =>
                  Schema.decodeEffect(
                    Schema.fromJsonString(Schema.Struct({ by: Schema.Int, source: Schema.String })),
                  )(decompress(value)).pipe(Effect.map((event) => ({ ...event, sequence }))),
                ),
              ),
            )
            const first = yield* spawn(12, 1)
            const second = yield* spawn(12, 1)
            yield* first.send("GO")
            yield* second.send("GO")
            yield* until(
              Effect.sync(() => first.acked.size >= 2 && second.acked.size >= 2),
              "both original command pairs",
              "15 seconds",
            )
            yield* until(
              events.pipe(Effect.map((rows) => rows.length >= 2)),
              "singleton events",
              "15 seconds",
            )
            const owner = (yield* events).at(-1)!.by
            const dead = [first, second].find(({ port }) => port === owner)!
            const alive = [first, second].find((runner) => runner !== dead)!
            yield* dead.child.kill({ killSignal: "SIGKILL" })
            expect(String((yield* dead.child.exitCode.pipe(Effect.flip)).cause)).toContain(
              "SIGKILL",
            )
            yield* until(
              events.pipe(Effect.map((rows) => rows.at(-1)!.by !== owner)),
              "pooled singleton takeover",
              "20 seconds",
            )
            const handover = (yield* events).at(-1)!.sequence
            const replacement = yield* spawn(9, 1)
            yield* replacement.send("GO")
            yield* until(
              Effect.sync(() => replacement.acked.size >= 2),
              "replacement command pair",
              "15 seconds",
            )
            const beforeBackendLoss = (yield* events).at(-1)!.sequence
            const backendPids = (yield* Effect.promise(() => proxy.query("SHOW SERVERS"))).rows
              .filter((row: { database: string }) => row.database === name)
              .map((row: { remote_pid: number }) => Number(row.remote_pid))
            expect(backendPids.length).toBeGreaterThan(0)
            const terminated = yield* Effect.promise(() =>
              direct.query(
                "SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE datname = current_database() AND pid = ANY($1::int[])",
                [backendPids],
              ),
            )
            expect(terminated.rows.some((row: { terminated: boolean }) => row.terminated)).toBe(
              true,
            )
            yield* until(
              events.pipe(
                Effect.map((rows) => BigInt(rows.at(-1)!.sequence) > BigInt(beforeBackendLoss)),
              ),
              "work after backend termination",
              "20 seconds",
            )
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* Effect.acquireRelease(docker(["pause", id]), () =>
                  docker(["unpause", id]).pipe(Effect.orDie),
                )
                yield* Effect.sleep("4 seconds")
                const paused = yield* events
                expect(
                  (yield* query<{ count: number }>(
                    "SELECT count(*)::int AS count FROM cluster_locks WHERE acquired_at > now() - interval '3 seconds'",
                  ))[0]!.count,
                ).toBe(0)
                yield* Effect.sleep("1 second")
                expect(yield* events).toEqual(paused)
              }),
            )
            const beforeRestart = (yield* events).at(-1)!.sequence
            yield* docker(["kill", "--signal", "KILL", id])
            yield* docker(["start", id])
            expect(yield* docker(["inspect", "--format", "{{.State.Running}}", id])).toBe("true")
            expect(yield* docker(["port", id, "5432/tcp"])).toBe(`127.0.0.1:${port}`)
            yield* Effect.tryPromise(() => proxy.query("SHOW VERSION")).pipe(
              Effect.retry({ times: 30, schedule: Schedule.spaced("100 millis") }),
            )
            expect(proxyErrors).toHaveLength(1)
            yield* until(
              events.pipe(
                Effect.map((rows) => BigInt(rows.at(-1)!.sequence) > BigInt(beforeRestart)),
              ),
              "work after pooler restart",
              "30 seconds",
            )
            yield* alive.send("RESUME")
            yield* replacement.send("RESUME")
            yield* until(
              Effect.sync(() => alive.finished && replacement.finished),
              "survivor commands",
              "30 seconds",
            )
            yield* until(
              query<{ count: number }>(
                "SELECT count(*)::int AS count FROM actor_outbox WHERE kind = 'intent' AND timer_key IS NULL",
              ).pipe(Effect.map((rows) => rows[0]!.count === 0)),
              "all deliveries",
              "15 seconds",
            )
            for (const runner of [alive, replacement]) {
              yield* runner.send("DRAIN")
              yield* until(
                Effect.sync(() => runner.drained !== undefined),
                "clean drain",
                "15 seconds",
              )
              expect(
                yield* Schema.decodeEffect(
                  Schema.fromJsonString(
                    Schema.Struct({
                      outcome: Schema.String,
                      interruptedTurns: Schema.Int,
                      interruptedJobs: Schema.Int,
                    }),
                  ),
                )(runner.drained!),
              ).toMatchObject({
                outcome: "clean",
                interruptedTurns: 0,
                interruptedJobs: 0,
              })
              yield* runner.send("EXIT")
              yield* runner.child.exitCode.pipe(Effect.ignore, Effect.timeout("5 seconds"))
            }
            const receipts = yield* query<{ command_id: string; command: string }>(
              "SELECT command_id, command FROM actor_receipts",
            )
            const ids = new Set(receipts.map(({ command_id }) => command_id))
            expect(all.flatMap(({ acked }) => [...acked].filter((key) => !ids.has(key)))).toEqual(
              [],
            )
            const count = (command: string) =>
              receipts.filter((row) => row.command === command).length
            expect(count("Increment")).toBe(22)
            expect(count("Send")).toBe(22)
            expect(count("Add")).toBe(22)
            const total = (actor: string) =>
              query<{ value: Uint8Array }>(
                `SELECT value FROM actor_state WHERE actor_type = '${actor}' AND key = 'count'`,
              ).pipe(
                Effect.map((rows) =>
                  rows.reduce((sum, { value }) => sum + Number(decompress(value)), 0),
                ),
              )
            expect(yield* total("DrillCounter")).toBe(22)
            expect(yield* total("DrillReceiver")).toBe(22)
            expect(yield* total("DrillBeacon")).toBe(count("Pulse") + count("Loop"))
            const after = yield* events
            expect(after).toHaveLength(count("Pulse") + count("Loop"))
            expect(
              after
                .filter(({ sequence }) => BigInt(sequence) > BigInt(handover))
                .every(({ by }) => by !== owner),
            ).toBe(true)
            expect(
              (yield* query<{ count: number }>(
                "SELECT count(*)::int AS count FROM cluster_locks WHERE acquired_at > now() - interval '3 seconds'",
              ))[0]!.count,
            ).toBe(0)
            expect(
              (yield* Effect.promise(() =>
                direct.query(
                  "SELECT count(*)::int AS count FROM cluster_locks WHERE address = ANY($1::text[])",
                  [[`127.0.0.1:${alive.port}`, `127.0.0.1:${replacement.port}`]],
                ),
              )).rows,
            ).toEqual([{ count: 0 }])
          }),
        ),
      ),
    120_000,
  )
})
