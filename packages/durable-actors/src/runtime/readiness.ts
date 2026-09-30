import { Context, Crypto, Effect, Option } from "effect"
import { PgliteClient } from "@effect/sql-pglite"
import { Sharding } from "effect/unstable/cluster"
import { SqlClient } from "effect/unstable/sql"
import type { Readiness } from "./drain.ts"

/** How long readiness waits for the database before it reports storage unavailable. */
const READINESS_STORAGE_TIMEOUT = "2 seconds"

/** How long readiness reuses its last storage answer. */
const READINESS_CACHE = "1 second"

/**
 * Builds the runtime's readiness answer, returned as `serving`: not ready
 * while routing is shut down or nothing is registered, otherwise ready when
 * storage answers. PGlite always answers from the layer's own lifetime, since
 * a single connection held by a turn would make a probe report unready;
 * Postgres answers at most once a second.
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

    return (yield* storage)
      ? ({ ready: true } as const)
      : ({ ready: false, reason: "storage" } as const)
  }) satisfies Effect.Effect<Readiness>

  return { serving }
})
