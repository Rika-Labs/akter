import {
  Clock,
  Config,
  Context,
  Crypto,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
} from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { PgClient } from "@effect/sql-pg"
import { SqlClient } from "effect/sql"
import {
  databaseName,
  disposableDatabase,
  sweepStaleDatabases,
} from "../../../../../packages/akter/src/testing/database.ts"
import { cryptoLayer } from "../platform.ts"
import { postgresBackend } from "./database.ts"

/** Each `DROP DATABASE` waits for a checkpoint, which takes seconds on a shared server. */
const DROPS_MS = 60_000

const harness = ManagedRuntime.make(cryptoLayer)

afterAll(() => harness.dispose())

describe("Postgres test databases", () => {
  const replicaUrl = Option.getOrUndefined(
    Effect.runSync(Config.option(Config.String("TEST_REPLICA_DATABASE_URL"))),
  )

  it.runIf(replicaUrl !== undefined)(
    "waits for a new database to reach a paused replica instead of failing its control connection",
    () =>
      harness.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const primary = yield* Config.Redacted("TEST_DATABASE_URL")
            const control = Context.get(
              yield* Layer.build(
                PgClient.layer({ url: Redacted.make(replicaUrl!), maxConnections: 1 }),
              ),
              SqlClient.SqlClient,
            )
            yield* Effect.acquireRelease(control`SELECT pg_wal_replay_pause()`, () =>
              control`SELECT pg_wal_replay_resume()`.pipe(Effect.asVoid, Effect.orDie),
            )
            const backend = postgresBackend({
              url: Effect.succeed(Redacted.value(primary)),
              replicaUrl,
            })
            const opened = yield* Effect.acquireRelease(
              Effect.promise(() => backend.open()),
              (opened) => opened.close,
            )
            const replica = opened.replica!
            const connected = yield* replica.connect.pipe(Effect.forkChild)
            yield* Effect.sleep("150 millis")
            expect(connected.pollUnsafe()).toBeUndefined()
            yield* control`SELECT pg_wal_replay_resume()`
            const connection = yield* Fiber.join(connected)
            expect(yield* connection.query("SELECT 37 AS value")).toEqual([{ value: 37 }])
          }),
        ),
      ),
  )
  it(
    "drops a disposable database with its scope and sweeps only databases older than an hour",
    { timeout: DROPS_MS },
    () =>
      harness.runPromise(
        Effect.gen(function* () {
          const url = yield* Config.Redacted("TEST_DATABASE_URL")

          const admin = Context.get(
            yield* Layer.build(PgClient.layer({ url, maxConnections: 1 })),
            SqlClient.SqlClient,
          )

          const exists = (name: string) =>
            admin`SELECT 1 FROM pg_database WHERE datname = ${name}`.pipe(
              Effect.map((rows) => rows.length === 1),
            )

          const nameOf = (database: Redacted.Redacted<string>) =>
            new URL(Redacted.value(database)).pathname.slice(1)

          const disposed = yield* Effect.scoped(
            Effect.gen(function* () {
              const name = nameOf(yield* disposableDatabase({ url }))
              expect(yield* exists(name)).toBe(true)

              return name
            }),
          )

          expect(yield* exists(disposed)).toBe(false)

          const live = yield* databaseName(yield* Crypto.Crypto, "isolated")
          const uuid = (yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")
          const stale = `isolated_${(yield* Clock.currentTimeMillis) - 2 * 60 * 60 * 1000}_${uuid}`

          yield* Effect.forEach([live, stale], (name) => admin.unsafe(`CREATE DATABASE "${name}"`))
          yield* sweepStaleDatabases(url)

          expect(yield* exists(stale)).toBe(false)
          expect(yield* exists(live)).toBe(true)
          yield* admin.unsafe(`DROP DATABASE "${live}" WITH (FORCE)`)
        }).pipe(Effect.scoped),
      ),
  )
})
