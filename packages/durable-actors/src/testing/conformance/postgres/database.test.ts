import { BunCrypto } from "@effect/platform-bun"
import { Clock, Config, Context, Crypto, Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { PgClient } from "@effect/sql-pg"
import { SqlClient } from "effect/unstable/sql"
import { databaseName, disposableDatabase, sweepStaleDatabases } from "../../database.ts"

/** Each `DROP DATABASE` waits for a checkpoint, which takes seconds on a shared server. */
const DROPS_MS = 60_000

const harness = ManagedRuntime.make(BunCrypto.layer)

afterAll(() => harness.dispose())

describe("Postgres test databases", () => {
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
