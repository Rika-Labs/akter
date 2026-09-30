import { BunCrypto } from "@effect/platform-bun"
import { Clock, Config, Crypto, Effect, ManagedRuntime } from "effect"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { databaseName, dropDatabases, sweepStaleDatabases } from "./database.ts"

const harness = ManagedRuntime.make(BunCrypto.layer)

afterAll(() => harness.dispose())

/** Each `DROP DATABASE` waits for a checkpoint, which takes seconds on a shared server. */
const DROPS_MS = 60_000

describe("Postgres conformance databases", () => {
  it("sweeps test databases older than an hour and keeps a live run's", { timeout: DROPS_MS }, () =>
    harness.runPromise(
      Effect.gen(function* () {
        const admin = new Pool({ connectionString: yield* Config.String("TEST_DATABASE_URL") })
        const crypto = yield* Crypto.Crypto
        const live = yield* databaseName(crypto, "isolated")
        const uuid = (yield* crypto.randomUUIDv4).replaceAll("-", "")
        const stale = `isolated_${(yield* Clock.currentTimeMillis) - 2 * 60 * 60 * 1000}_${uuid}`

        const exists = (name: string) =>
          Effect.promise(() =>
            admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]),
          ).pipe(Effect.map(({ rowCount }) => rowCount === 1))

        yield* Effect.forEach([live, stale], (name) =>
          Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
        )
        yield* sweepStaleDatabases(admin)

        expect(yield* exists(stale)).toBe(false)
        expect(yield* exists(live)).toBe(true)

        yield* dropDatabases({ admin, names: [live] })
        yield* Effect.promise(() => admin.end())
      }),
    ),
  )
})
