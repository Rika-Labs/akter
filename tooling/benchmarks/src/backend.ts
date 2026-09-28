import { connect } from "node:net"
import { Database } from "@durable-actors/core/runtime"
import { TurnPoolSettings } from "@durable-actors/core/testing"
import { Context, Effect, Fiber, Layer, Redacted, Schedule, type Scope } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { flightCounter } from "./flights.ts"

export type BackendName = "postgres" | "pglite"

/** Wait-event and connection-state samples of one database, as fractions of samples. */
export interface Activity {
  readonly samples: number
  /** Mean number of client connections in each state per sample. */
  readonly connections: Readonly<Record<string, number>>
  /** Most client connections open at once in any sample. */
  readonly peakConnections: number
}

export interface StatementCount {
  readonly query: string
  readonly calls: number
  readonly meanMs: number
}

/** Server-side instruments; only a real Postgres server has them. */
export interface Instruments {
  readonly resetStatements: Effect.Effect<void>
  readonly statements: Effect.Effect<{
    readonly calls: number
    readonly top: ReadonlyArray<StatementCount>
    /** Every statement, most-called first; `top` is its first 16. */
    readonly all: ReadonlyArray<StatementCount>
  }>
  readonly sampleActivity: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<readonly [A, Activity], E, R>
  /** Database-server CPU seconds consumed so far; present when the harness owns the server. */
  readonly serverCpuSeconds: Effect.Effect<number | undefined> | undefined
  /** Zeroes the turn-session flight count. */
  readonly resetFlights: Effect.Effect<void>
  /** Round trips turns waited for on their sessions since the last reset. */
  readonly flights: Effect.Effect<number>
}

export interface CaseDatabase {
  readonly layer: Layer.Layer<SqlClient.SqlClient>
  /** The case database's URL on a real server, for runtimes that open their own pools. */
  readonly url: Redacted.Redacted<string> | undefined
  readonly instruments: Instruments | undefined
}

export interface Backend {
  readonly name: BackendName
  readonly version: string
  readonly settings: Readonly<Record<string, string>>
  /** A fresh, empty database for one measured case, dropped when the scope closes. */
  readonly database: (options: {
    readonly maxConnections: number
  }) => Effect.Effect<CaseDatabase, never, Scope.Scope>
}

const CONTAINER = "durable-actors-bench-postgres"

const IMAGE = "postgres:18.6-bookworm"

const PORT = 55_432

const run = (args: ReadonlyArray<string>) =>
  Effect.sync(() => {
    const result = Bun.spawnSync(["docker", ...args])

    return {
      ok: result.exitCode === 0,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }
  })

const docker = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
  const result = yield* run(args)

  if (!result.ok) return yield* Effect.die(new Error(`docker ${args[0]} failed: ${result.stderr}`))

  return result.stdout
})

const SETTINGS = [
  "shared_buffers",
  "max_connections",
  "synchronous_commit",
  "fsync",
  "full_page_writes",
  "wal_level",
  "max_wal_size",
  "checkpoint_timeout",
  "work_mem",
] as const

/**
 * Starts a disposable Postgres 18 container with pg_stat_statements loaded
 * and every durability setting at its default, unless `BENCH_DATABASE_URL`
 * names an existing server. Each case gets its own database on that server.
 */
export const postgres = (external: string | undefined) =>
  Effect.gen(function* () {
    const owned = external === undefined

    if (owned) {
      yield* run(["rm", "-f", CONTAINER])
      yield* Effect.acquireRelease(
        docker([
          "run",
          "-d",
          "--name",
          CONTAINER,
          "--shm-size=1g",
          "-e",
          "POSTGRES_USER=bench",
          "-e",
          "POSTGRES_PASSWORD=bench",
          "-e",
          "POSTGRES_DB=postgres",
          "-p",
          `127.0.0.1:${PORT}:5432`,
          IMAGE,
          "-c",
          "shared_preload_libraries=pg_stat_statements",
        ]),
        () => run(["rm", "-f", CONTAINER]),
      )
    }

    const server = new URL(external ?? `postgres://bench:bench@127.0.0.1:${PORT}/postgres`)

    const url = (database: string) => {
      const next = new URL(server.href)
      next.pathname = `/${database}`

      return Redacted.make(next.href)
    }

    const admin = Context.get(
      yield* Layer.build(
        Database.postgres({ url: url(server.pathname.slice(1) || "postgres"), maxConnections: 2 }),
      ).pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 120 }), Effect.orDie),
      SqlClient.SqlClient,
    )

    yield* admin`SELECT 1`.pipe(
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 120 }),
      Effect.orDie,
    )
    yield* admin`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`.pipe(Effect.orDie)

    const version = (yield* admin<{ version: string }>`SELECT version()`.pipe(Effect.orDie))[0]!
      .version

    const settings = Object.fromEntries(
      (yield* admin<{ name: string; setting: string; unit: string | null }>`
        SELECT name, setting, unit FROM pg_settings WHERE name IN ${admin.in(SETTINGS)}`.pipe(
        Effect.orDie,
      )).map(({ name, setting, unit }) => [name, unit === null ? setting : `${setting} ${unit}`]),
    )

    const cpuSeconds = owned
      ? run(["exec", CONTAINER, "cat", "/sys/fs/cgroup/cpu.stat"]).pipe(
          Effect.map((result) => {
            const usage = /usage_usec (\d+)/.exec(result.stdout)?.[1]

            return usage === undefined ? undefined : Number(usage) / 1e6
          }),
        )
      : undefined

    let databases = 0

    const database = Effect.fnUntraced(function* (options: { readonly maxConnections: number }) {
      databases += 1
      const name = `bench_${process.pid}_${databases}`

      yield* Effect.acquireRelease(
        admin.unsafe(`CREATE DATABASE "${name}"`).pipe(Effect.orDie),
        () => admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`).pipe(Effect.ignore),
      )

      const statements = Effect.gen(function* () {
        const top = yield* admin<{ query: string; calls: string; mean: number }>`
          SELECT s.query, s.calls::text AS calls, s.mean_exec_time AS mean
          FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid
          WHERE d.datname = ${name}
            AND s.query NOT LIKE '%cluster_%' AND s.query NOT LIKE '%pg_locks%'
          ORDER BY s.calls DESC`

        const all = top.map((row) => ({
          query: row.query.replace(/\s+/g, " ").slice(0, 160),
          calls: Number(row.calls),
          meanMs: Math.round(row.mean * 1000) / 1000,
        }))

        return {
          calls: top.reduce((sum, row) => sum + Number(row.calls), 0),
          top: all.slice(0, 16),
          all,
        }
      }).pipe(Effect.orDie)

      const sampleActivity = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const totals = new Map<string, number>()
          let samples = 0
          let peakConnections = 0

          const sampler = yield* Effect.forkChild(
            Effect.gen(function* () {
              const rows = yield* admin<{ bucket: string; count: number }>`
                SELECT state || coalesce(':' || wait_event_type || '/' || wait_event, '') AS bucket,
                  count(*)::int AS count
                FROM pg_stat_activity
                WHERE datname = ${name} AND backend_type = 'client backend'
                GROUP BY 1`.pipe(Effect.orDie)

              samples += 1
              peakConnections = Math.max(
                peakConnections,
                rows.reduce((total, { count }) => total + count, 0),
              )

              for (const { bucket, count } of rows)
                totals.set(bucket, (totals.get(bucket) ?? 0) + count)
            }).pipe(Effect.repeat(Schedule.spaced("25 millis"))),
          )

          const result = yield* effect
          yield* Fiber.interrupt(sampler)

          const connections = Object.fromEntries(
            [...totals]
              .sort(([, a], [, b]) => b - a)
              .map(([bucket, total]) => [
                bucket,
                Math.round((total / Math.max(samples, 1)) * 100) / 100,
              ]),
          )

          return [result, { samples, connections, peakConnections }] as const
        })

      const counter = yield* flightCounter(server)

      return {
        layer: Database.postgres({ url: url(name), maxConnections: options.maxConnections }).pipe(
          Layer.provide(
            Layer.succeed(TurnPoolSettings, {
              stream: () => connect({ host: "127.0.0.1", port: counter.port, noDelay: true }),
            }),
          ),
          Layer.orDie,
        ),
        url: url(name),
        instruments: {
          resetStatements: admin`SELECT pg_stat_statements_reset()`.pipe(
            Effect.orDie,
            Effect.asVoid,
          ),
          statements,
          sampleActivity,
          serverCpuSeconds: cpuSeconds,
          resetFlights: counter.reset,
          flights: counter.flights,
        },
      } satisfies CaseDatabase
    })

    return { name: "postgres", version, settings, database } satisfies Backend
  })

/** In-process PGlite: one connection, no server, no independent-connection behavior. */
export const pglite = Effect.gen(function* () {
  const probe = Context.get(yield* Layer.build(Database.pglite()), SqlClient.SqlClient)
  const version = (yield* probe<{ version: string }>`SELECT version()`)[0]!.version

  return {
    name: "pglite",
    version,
    settings: { connections: "1 (in-process)", storage: "in-memory" },
    database: () =>
      Effect.succeed({
        layer: Database.pglite().pipe(Layer.orDie),
        url: undefined,
        instruments: undefined,
      }),
  } satisfies Backend
}).pipe(Effect.orDie)
