import { BunCrypto, BunServices } from "@effect/platform-bun"
import { fileURLToPath } from "node:url"
import {
  Config,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Schedule,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ShardingConfig } from "effect/cluster"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { Actors } from "../../index.ts"
import { Database } from "../../layer.ts"
import { migrate, migrations, migrator } from "../migrations.ts"
import { MigrationBoundary, prepareRunnerStorage } from "./migrations.ts"
import { disposableDatabase } from "../../../testing/database.ts"

const harness = ManagedRuntime.make(Layer.merge(BunCrypto.layer, BunServices.layer))
afterAll(() => harness.dispose())

const previous = Object.fromEntries(Object.entries(migrations).filter(([key]) => key < "0026"))
const expectedIds = [
  1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 22, 23, 24, 25, 26, 27, 29,
]
const query = (pool: Pool, sql: string) => Effect.promise(() => pool.query(sql))

/** The local barrier rejects DDL inside BEGIN; these scenarios never claim Neki evidence. */
const withDatabase = <A, E, R>(
  use: (url: string, pool: Pool) => Effect.Effect<A, E, R>,
  neki = false,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = neki
        ? yield* Config.Redacted("TEST_NEKI_DATABASE_URL")
        : yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") })
      const pool = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: Redacted.value(database) })),
        (connection) => Effect.promise(() => connection.end()),
      )
      if (neki) {
        const occupied = yield* query(
          pool,
          `SELECT 1 FROM pg_class WHERE relnamespace = to_regnamespace(current_schema())
          AND (relname LIKE 'actor_%' OR relname LIKE 'tenant_content%' OR relname IN ('cluster_runners', 'cluster_locks'))
        UNION ALL SELECT 1 FROM pg_namespace WHERE nspname = 'durable'`,
        )
        if (occupied.rowCount !== 0)
          return yield* Effect.die(
            new Error(
              "Neki migration tests require a dedicated empty database; refusing to modify an existing framework schema",
            ),
          )
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* query(pool, "DROP SCHEMA IF EXISTS durable CASCADE")
            yield* query(pool, "SELECT __neki.wait_for_ddl()")
            const tables = yield* query(
              pool,
              `SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
              WHERE schemaname = current_schema() AND (tablename LIKE 'actor_%' OR tablename LIKE 'tenant_content%' OR tablename IN ('cluster_runners', 'cluster_locks'))`,
            )
            for (const { name } of tables.rows) {
              yield* query(pool, `DROP TABLE IF EXISTS ${name} CASCADE`)
              yield* query(pool, "SELECT __neki.wait_for_ddl()")
            }
            for (const name of ["actor_adoption_observe", "actor_adoption_guard"]) {
              yield* query(pool, `DROP FUNCTION IF EXISTS ${name}()`)
              yield* query(pool, "SELECT __neki.wait_for_ddl()")
            }
          }),
        )
        return yield* use(Redacted.value(database), pool)
      }
      yield* query(pool, "CREATE SCHEMA __neki")
      yield* query(pool, "CREATE TABLE neki_barriers (calls integer NOT NULL)")
      yield* query(pool, "INSERT INTO neki_barriers VALUES (0)")
      yield* query(
        pool,
        `CREATE FUNCTION __neki.wait_for_ddl() RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
          RAISE EXCEPTION 'DDL propagation was requested inside a writing transaction';
        END IF;
        UPDATE neki_barriers SET calls = calls + 1;
      END
    $$`,
      )
      return yield* use(Redacted.value(database), pool)
    }),
  )

const run = (url: string, effect = migrate, neki = true) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Database.postgres({ url: Redacted.make(url), neki, offTurnConnections: 1 }),
      )
      return yield* Effect.provide(effect, context)
    }),
  )

const spawn = Effect.fnUntraced(function* (command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const runner = yield* spawner.spawn(command)
  const stderr = yield* runner.stderr.pipe(Stream.decodeText(), Stream.mkString, Effect.forkChild)
  const stderrOutput = Fiber.join(stderr)
  return {
    ...runner,
    stderrOutput,
    exitCode: runner.exitCode.pipe(
      Effect.tap((code) =>
        code === 0
          ? Effect.void
          : stderrOutput.pipe(
              Effect.flatMap((output) =>
                Effect.die(
                  new Error(`Migration child exited with code ${code}; stderr:\n${output}`),
                ),
              ),
            ),
      ),
    ),
  }
})

/** A real child pauses after the database operation; SIGKILL cannot release its lock in a finalizer. */
const child = Effect.fnUntraced(function* (
  url: string,
  point?: string,
  coordinationUrl?: string,
  neki = true,
) {
  const code = `
    import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
    import { Database } from "./packages/akter/src/runtime/layer.ts";
    import { migrate } from "./packages/akter/src/runtime/database/migrations.ts";
    import { Coordination } from "./packages/akter/src/runtime/database/coordination.ts";
    import { MigrationBoundary, prepareRunnerStorage } from "./packages/akter/src/runtime/database/neki/migrations.ts";
    import { ShardingConfig } from "effect/cluster";
    import { SqlClient } from "effect/sql";
    const boundary = p => p === process.env.MIGRATION_POINT ? Effect.sync(() => console.log("READY")).pipe(Effect.andThen(Effect.never)) : Effect.void;
    const prepare = Effect.gen(function* () {
      const sql = (yield* Coordination) ?? (yield* SqlClient.SqlClient);
      yield* prepareRunnerStorage.pipe(Effect.provideService(SqlClient.SqlClient, sql));
    });
    const runtime = ManagedRuntime.make(Database.postgres({url: Redacted.make(process.env.MIGRATION_URL), neki: process.env.MIGRATION_NEKI === "true", offTurnConnections: 1, coordination: process.env.COORDINATION_URL ? {url: Redacted.make(process.env.COORDINATION_URL), maxConnections: 1} : undefined}).pipe(Layer.provide(Layer.succeed(MigrationBoundary, boundary))));
    try {
      const result = await runtime.runPromise(migrate.pipe(Effect.tap(() => prepare), Effect.provideService(ShardingConfig.ShardingConfig, {...ShardingConfig.defaults, shardLockDisableAdvisory: true}), Effect.provideService(MigrationBoundary, boundary)));
      console.log("RESULT " + JSON.stringify(result));
    } finally { await runtime.dispose(); }
  `
  return yield* spawn(
    ChildProcess.make("bun", ["-e", code], {
      env: {
        MIGRATION_URL: url,
        MIGRATION_POINT: point ?? "",
        COORDINATION_URL: coordinationUrl ?? "",
        MIGRATION_NEKI: String(neki),
      },
      extendEnv: true,
      cwd: fileURLToPath(new URL("../../../../../../", import.meta.url)),
      stderr: "pipe",
    }),
  )
})

const ready = (runner: Effect.Success<ReturnType<typeof spawn>>) =>
  Effect.gen(function* () {
    const lines = yield* runner.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line === "READY"),
      Stream.take(1),
      Stream.runCollect,
    )
    if (lines.length === 1) return
    const stderr = yield* runner.stderrOutput
    expect(lines, `Child migration exited before READY; stderr:\n${stderr}`).toEqual(["READY"])
  })

const crash = (url: string, point: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const runner = yield* child(url, point)
      yield* ready(runner)
      yield* runner.kill({ killSignal: "SIGKILL" })
      expect(String((yield* runner.exitCode.pipe(Effect.flip)).cause)).toContain("SIGKILL")
    }),
  )

const assertSchema = (pool: Pool, neki = false) =>
  Effect.gen(function* () {
    expect(
      (yield* query(
        pool,
        "SELECT migration_id FROM actor_migrations ORDER BY migration_id",
      )).rows.map(({ migration_id }) => migration_id),
    ).toEqual(expectedIds)
    expect(
      (yield* query(
        pool,
        "SELECT count(*)::int AS pending FROM actor_migration_steps WHERE NOT completed",
      )).rows,
    ).toEqual([{ pending: 0 }])
    if (!neki)
      expect((yield* query(pool, "SELECT calls FROM neki_barriers")).rows[0].calls).toBeGreaterThan(
        100,
      )
    expect(
      (yield* query(
        pool,
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'actor_dead_letters' AND column_name IN ('effect', 'effect_id', 'job', 'job_id') ORDER BY column_name",
      )).rows,
    ).toEqual([{ column_name: "job" }, { column_name: "job_id" }])
    expect(
      (yield* query(
        pool,
        "SELECT to_regclass('durable.jobs')::text AS jobs, to_regclass('durable.effects')::text AS effects",
      )).rows,
    ).toEqual([{ jobs: "durable.jobs", effects: null }])
    expect(
      (yield* query(
        pool,
        "SELECT relrowsecurity FROM pg_class WHERE oid = 'actor_state'::regclass",
      )).rows,
    ).toEqual([{ relrowsecurity: true }])
    expect(
      (yield* query(
        pool,
        "SELECT to_regclass('cluster_runners')::text AS runners, to_regclass('cluster_locks')::text AS locks",
      )).rows,
    ).toEqual([{ runners: "cluster_runners", locks: "cluster_locks" }])
  })

const prepare = (url: string, pool: Pool, neki = false) =>
  Effect.gen(function* () {
    yield* run(url, migrator(previous), neki)
    yield* query(
      pool,
      "INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id) VALUES (17, 't', 'A', 'x')",
    )
    yield* query(
      pool,
      `INSERT INTO actor_outbox (routing_key, bucket, tenant_id, actor_type, actor_id, intent_id, target_type, target_id, command, payload, caller, due_at_ms, scheduled_at_ms, kind, ready_at_ms, timer_key)
    VALUES (17, 0, 't', 'A', 'x', 'stable-id', 'A', 'x', 'send', '{}', '{}', 130, 110, 'effect', 120, '$effect:send')`,
    )
    yield* query(
      pool,
      "INSERT INTO actor_dead_letters (routing_key, effect_id, tenant_id, actor_type, actor_id, effect, payload, attempts, cause, ambiguous, dead_at_ms) VALUES (17, 'dead-id', 't', 'A', 'x', 'send', '{}', 3, 'lost', true, 150)",
    )
    yield* query(
      pool,
      "INSERT INTO actor_payload_versions (actor_type, kind, tag, version, first_written_at_ms) VALUES ('A', 'effect', 'send', 2, 99)",
    )
    yield* query(
      pool,
      "INSERT INTO actor_payload_writers (runtime_id, actor_type, kind, tag, version, window_ms, refreshed_at_ms) VALUES ('writer', 'A', 'effect', 'send', 3, 411, 87)",
    )
    yield* query(
      pool,
      `INSERT INTO actor_outbox (routing_key, bucket, tenant_id, actor_type, actor_id, intent_id, target_type, target_id, command, payload, caller, due_at_ms, scheduled_at_ms, kind, timer_key)
        VALUES (17, 0, 't', 'A', 'x', 'untouched-id', 'B', 'y', 'deliver', '{}', '{}', 290, 270, 'intent', '$effect:untouched')`,
    )
  })

const describeMigrations = (neki: boolean) => {
  const target = <A, E, R>(use: (url: string, pool: Pool) => Effect.Effect<A, E, R>) =>
    withDatabase(use, neki)
  it(
    "recovers SIGKILL after every durable boundary, including applied DDL before its checkpoint",
    () =>
      harness.runPromise(
        Effect.gen(function* () {
          const points: Array<string> = []
          yield* target((url) =>
            run(
              url,
              migrate.pipe(
                Effect.tap(() => prepareRunnerStorage),
                Effect.provideService(ShardingConfig.ShardingConfig, {
                  ...ShardingConfig.defaults,
                  shardLockDisableAdvisory: true,
                }),
                Effect.provideService(MigrationBoundary, (point) =>
                  Effect.sync(() => {
                    points.push(point)
                  }),
                ),
              ),
            ),
          )
          expect(points.length).toBeGreaterThan(500)
          yield* target((url, pool) =>
            Effect.gen(function* () {
              for (const point of points) yield* crash(url, point)
              const restarted = yield* child(url)
              expect(yield* restarted.exitCode).toBe(0)
              yield* assertSchema(pool, neki)
              expect(yield* run(url)).toEqual([])
            }),
          )
        }).pipe(Effect.scoped),
      ),
    neki ? 1_800_000 : 300_000,
  )

  it("makes a concurrent startup wait for the owner and recover when that owner dies", () =>
    harness.runPromise(
      target((url, pool) =>
        Effect.gen(function* () {
          const owner = yield* child(url, "1:1:applied")
          yield* ready(owner)
          const contender = yield* child(url)
          const completed = yield* Effect.forkChild(contender.exitCode)
          if (neki) {
            yield* Effect.sleep("200 millis")
            expect(completed.pollUnsafe()).toBeUndefined()
          } else
            yield* query(
              pool,
              "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'",
            ).pipe(
              Effect.flatMap((waiting) =>
                waiting.rowCount! > 0 ? Effect.void : Effect.fail("not waiting"),
              ),
              Effect.retry({ times: 200, schedule: Schedule.spaced("10 millis") }),
            )
          yield* owner.kill({ killSignal: "SIGKILL" })
          expect(String((yield* owner.exitCode.pipe(Effect.flip)).cause)).toContain("SIGKILL")
          expect(yield* Fiber.join(completed)).toBe(0)
          yield* assertSchema(pool, neki)
          expect(yield* run(url)).toEqual([])
        }),
      ),
    ))

  it(
    "upgrades the previous level through every crash boundary while preserving job identity and data",
    () =>
      harness.runPromise(
        Effect.gen(function* () {
          const points: Array<string> = []
          yield* target((url, pool) =>
            Effect.gen(function* () {
              yield* prepare(url, pool, neki)
              yield* run(
                url,
                migrate.pipe(
                  Effect.tap(() => prepareRunnerStorage),
                  Effect.provideService(ShardingConfig.ShardingConfig, {
                    ...ShardingConfig.defaults,
                    shardLockDisableAdvisory: true,
                  }),
                  Effect.provideService(MigrationBoundary, (point) =>
                    Effect.sync(() => {
                      points.push(point)
                    }),
                  ),
                ),
              )
            }),
          )
          yield* target((url, pool) =>
            Effect.gen(function* () {
              yield* prepare(url, pool, neki)
              for (const point of points) yield* crash(url, point)
              const restarted = yield* child(url)
              expect(yield* restarted.exitCode).toBe(0)
              expect(
                (yield* query(
                  pool,
                  "SELECT intent_id, kind, timer_key, due_at_ms::int, scheduled_at_ms::int FROM actor_outbox ORDER BY intent_id",
                )).rows,
              ).toEqual([
                {
                  intent_id: "stable-id",
                  kind: "job",
                  timer_key: "$job:send",
                  due_at_ms: 130,
                  scheduled_at_ms: 110,
                },
                {
                  intent_id: "untouched-id",
                  kind: "intent",
                  timer_key: "$effect:untouched",
                  due_at_ms: 290,
                  scheduled_at_ms: 270,
                },
              ])
              expect(
                (yield* query(
                  pool,
                  "SELECT job_id, job, attempts, ambiguous FROM actor_dead_letters",
                )).rows,
              ).toEqual([{ job_id: "dead-id", job: "send", attempts: 3, ambiguous: true }])
              expect(
                (yield* query(pool, "SELECT kind, version FROM actor_payload_versions")).rows,
              ).toEqual([{ kind: "job", version: 2 }])
              expect(
                (yield* query(
                  pool,
                  "SELECT runtime_id, kind, version, window_ms::int, refreshed_at_ms::int FROM actor_payload_writers",
                )).rows,
              ).toEqual([
                {
                  runtime_id: "writer",
                  kind: "job",
                  version: 3,
                  window_ms: 411,
                  refreshed_at_ms: 87,
                },
              ])
              expect(yield* run(url)).toEqual([])
            }),
          )
        }).pipe(Effect.scoped),
      ),
    neki ? 600_000 : 90_000,
  )
}

describe("Neki migration protocol on real Postgres", () => {
  it("includes child stderr when startup exits before READY or with a nonzero code", () =>
    harness.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          for (const code of [0, 23]) {
            const runner = yield* spawn(
              ChildProcess.make("bun", [
                "-e",
                `console.error("startup diagnostic"); process.exit(${code})`,
              ]),
            )
            const readiness = yield* Effect.exit(ready(runner))
            expect(String(readiness)).toContain("Child migration exited before READY")
            expect(String(readiness)).toContain("startup diagnostic")
            if (code !== 0) {
              const exited = yield* Effect.exit(runner.exitCode)
              expect(String(exited)).toContain(`Migration child exited with code ${code}`)
              expect(String(exited)).toContain("startup diagnostic")
            }
          }
        }),
      ),
    ))

  describeMigrations(false)

  for (const neki of [false, true]) {
    it(`serializes six fresh process starts with a separate coordination database in ${neki ? "Neki protocol" : "Postgres"} mode`, () =>
      harness.runPromise(
        withDatabase((url, data) =>
          withDatabase((coordinationUrl, control) =>
            Effect.gen(function* () {
              const runners = yield* Effect.forEach(
                Array.from({ length: 6 }),
                () => child(url, undefined, coordinationUrl, neki),
                { concurrency: "unbounded" },
              )
              const exits = yield* Effect.forEach(runners, (runner) => runner.exitCode, {
                concurrency: "unbounded",
              })
              expect(exits).toEqual([0, 0, 0, 0, 0, 0])
              expect(
                (yield* query(
                  control,
                  "SELECT migration_id, name FROM actor_coordination_migrations ORDER BY migration_id",
                )).rows,
              ).toEqual([{ migration_id: 1, name: "coordination" }])
              expect(
                (yield* query(
                  control,
                  "SELECT to_regclass('cluster_runners')::text AS runners, to_regclass('cluster_locks')::text AS locks, to_regclass('actor_migrations')::text AS data",
                )).rows,
              ).toEqual([{ runners: "cluster_runners", locks: "cluster_locks", data: null }])
              expect(
                (yield* query(
                  data,
                  "SELECT to_regclass('cluster_runners')::text AS runners, to_regclass('actor_coordination_migrations')::text AS control",
                )).rows,
              ).toEqual([{ runners: null, control: null }])
              expect(
                (yield* query(
                  data,
                  "SELECT migration_id FROM actor_migrations ORDER BY migration_id",
                )).rows.map(({ migration_id }) => migration_id),
              ).toEqual(expectedIds)
            }),
          ),
        ),
      ))
  }

  it("replays every coordination bootstrap boundary after SIGKILL and admits a waiting owner", () =>
    harness.runPromise(
      withDatabase((url, data) =>
        withDatabase((coordinationUrl, control) =>
          Effect.gen(function* () {
            for (const point of [
              "coordination:history:ddl",
              "coordination:history:propagated",
              "coordination:resources:ddl",
              "coordination:resources:propagated",
              "coordination:recorded",
            ]) {
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const owner = yield* child(url, point, coordinationUrl)
                  yield* ready(owner)
                  const contender = yield* child(url, undefined, coordinationUrl)
                  const completed = yield* Effect.forkChild(contender.exitCode)
                  yield* query(
                    control,
                    "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'",
                  ).pipe(
                    Effect.flatMap((waiting) =>
                      waiting.rowCount! > 0 ? Effect.void : Effect.fail("not waiting"),
                    ),
                    Effect.retry({ times: 200, schedule: Schedule.spaced("10 millis") }),
                  )
                  expect(completed.pollUnsafe()).toBeUndefined()
                  yield* owner.kill({ killSignal: "SIGKILL" })
                  expect(String((yield* owner.exitCode.pipe(Effect.flip)).cause)).toContain(
                    "SIGKILL",
                  )
                  expect(yield* Fiber.join(completed)).toBe(0)
                }),
              )
            }
            expect(
              (yield* query(
                control,
                "SELECT migration_id, name FROM actor_coordination_migrations ORDER BY migration_id",
              )).rows,
            ).toEqual([{ migration_id: 1, name: "coordination" }])
            expect(
              (yield* query(
                data,
                "SELECT migration_id FROM actor_migrations ORDER BY migration_id",
              )).rows.map(({ migration_id }) => migration_id),
            ).toEqual(expectedIds)
          }),
        ),
      ),
    ))

  it("replays a migration whose statements already carry their own existence guards", () =>
    harness.runPromise(
      withDatabase((url, pool) =>
        Effect.gen(function* () {
          yield* run(
            url,
            migrator({
              "0001_guarded": Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient
                yield* sql`CREATE TABLE IF NOT EXISTS guarded_forms (id integer PRIMARY KEY)`
                yield* sql`ALTER TABLE guarded_forms ADD COLUMN IF NOT EXISTS note text, ADD COLUMN IF NOT EXISTS extra integer`
                yield* sql`CREATE INDEX IF NOT EXISTS guarded_forms_note ON guarded_forms (note)`
                yield* sql`DROP INDEX IF EXISTS guarded_forms_note`
                yield* sql`DROP TABLE IF EXISTS guarded_forms_absent`
              }),
            }),
          )
          expect(
            (yield* query(
              pool,
              "SELECT column_name FROM information_schema.columns WHERE table_name = 'guarded_forms' ORDER BY column_name",
            )).rows,
          ).toEqual([{ column_name: "extra" }, { column_name: "id" }, { column_name: "note" }])
          expect(
            (yield* query(
              pool,
              "SELECT count(*)::int AS steps, count(*) FILTER (WHERE completed)::int AS completed FROM actor_migration_steps",
            )).rows,
          ).toEqual([{ steps: 6, completed: 6 }])
        }),
      ),
    ))

  for (const completed of [false, true]) {
    it(`refuses a removed ${completed ? "completed" : "pending"} journaled step without recording the migration`, () =>
      harness.runPromise(
        withDatabase((url, pool) =>
          Effect.gen(function* () {
            const first = Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`CREATE TABLE immutable_steps (id integer PRIMARY KEY)`
            })
            const original = migrator({
              "0001_immutable": first.pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    const sql = yield* SqlClient.SqlClient
                    yield* sql`ALTER TABLE immutable_steps ADD COLUMN note text`
                  }),
                ),
              ),
            }).pipe(
              Effect.provideService(MigrationBoundary, (point) =>
                point === `1:2:${completed ? "completed" : "pending"}`
                  ? Effect.die(new Error("stop before recording"))
                  : Effect.void,
              ),
            )
            const stopped = yield* Effect.exit(run(url, original))
            expect(String(stopped)).toContain("stop before recording")
            const changed = yield* Effect.exit(run(url, migrator({ "0001_immutable": first })))
            expect(String(changed)).toContain("removed steps after it started")
            expect((yield* query(pool, "SELECT migration_id FROM actor_migrations")).rows).toEqual(
              [],
            )
            expect(
              (yield* query(
                pool,
                "SELECT step, completed FROM actor_migration_steps ORDER BY step",
              )).rows,
            ).toEqual([
              { step: 1, completed: true },
              { step: 2, completed },
            ])
          }),
        ),
      ))
  }

  it("starts six Actors.layer runners together on a completely fresh Postgres database", () =>
    harness.runPromise(
      withDatabase((url, pool) =>
        Effect.gen(function* () {
          yield* Effect.forEach(
            Array.from({ length: 6 }),
            () =>
              Effect.scoped(
                Layer.build(
                  Actors.layer().pipe(
                    Layer.provide(
                      Database.postgres({
                        url: Redacted.make(url),
                        offTurnConnections: 2,
                        maxConnections: 1,
                      }),
                    ),
                  ),
                ),
              ),
            { concurrency: "unbounded", discard: true },
          )
          expect(
            (yield* query(
              pool,
              "SELECT migration_id FROM actor_migrations ORDER BY migration_id",
            )).rows.map(({ migration_id }) => migration_id),
          ).toEqual(expectedIds)
          expect(
            (yield* query(pool, "SELECT to_regclass('actor_migration_steps')::text AS journal"))
              .rows,
          ).toEqual([{ journal: null }])
        }),
      ),
    ))
})

const nekiConfigured = Option.isSome(
  Effect.runSync(Config.option(Config.NonEmptyString("TEST_NEKI_DATABASE_URL"))),
)
describe.skipIf(!nekiConfigured)(
  "Neki startup migrations (requires TEST_NEKI_DATABASE_URL; skipped cases are not provider passes)",
  () => describeMigrations(true),
)
