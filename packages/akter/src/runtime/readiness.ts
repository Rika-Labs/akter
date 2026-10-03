import { Context, Crypto, Effect, Option } from "effect"
import { PgliteClient } from "@effect/sql-pglite"
import { Sharding } from "effect/cluster"
import { SqlClient } from "effect/sql"
import type { Readiness } from "./drain.ts"
import { RunnerReadiness } from "./runner.ts"

/** How long readiness waits for the database before it reports storage unavailable. */
const READINESS_STORAGE_TIMEOUT = "2 seconds"

/** How long readiness reuses its last storage answer. */
const READINESS_CACHE = "1 second"

/**
 * Builds the runtime's readiness answer, returned as `serving`: not ready
 * while routing is shut down, assigned shards are not acquired, or nothing is
 * registered, otherwise ready when storage answers. PGlite always answers from the layer's own lifetime, since
 * a single connection held by a turn would make a probe report unready;
 * Postgres storage answers are reused for at most a second; public runner
 * registration snapshots are checked on each probe.
 */
export const servingReadiness = Effect.fnUntraced(function* ({
  sharding,
  services,
  registrations,
  queryRegistrations,
  jobRegistrations,
}: {
  readonly sharding: Sharding.Sharding["Service"]
  readonly services: Context.Context<SqlClient.SqlClient | Crypto.Crypto | Sharding.Sharding>
  readonly registrations: ReadonlyMap<string, unknown>
  readonly queryRegistrations: ReadonlyMap<string, unknown>
  readonly jobRegistrations: ReadonlyMap<string, unknown>
}) {
  const embedded = Option.isSome(yield* Effect.serviceOption(PgliteClient.PgliteClient))
  const runner = yield* Effect.serviceOption(RunnerReadiness)

  const storage = embedded
    ? Effect.succeed(true)
    : yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient

        return yield* sql`SELECT 1`.pipe(
          Effect.timeoutOption(READINESS_STORAGE_TIMEOUT),
          Effect.map(Option.isSome),
          Effect.orElseSucceed(() => false),
        )
      }).pipe(Effect.provideContext(services), Effect.cachedWithTTL(READINESS_CACHE))

  const serving = Effect.gen(function* () {
    if (yield* sharding.isShutdown) return { ready: false, reason: "routing" } as const

    if (registrations.size + queryRegistrations.size + jobRegistrations.size === 0)
      return { ready: false, reason: "unregistered" } as const

    if (!(yield* storage)) return { ready: false, reason: "storage" } as const

    if (Option.isSome(runner) && !(yield* runner.value.acquired(sharding)))
      return { ready: false, reason: "routing" } as const

    return { ready: true } as const
  }) satisfies Effect.Effect<Readiness>

  return { serving }
})
