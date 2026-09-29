import { Effect, Schedule } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { EdgeOptions } from "../config.ts"

export interface Home {
  readonly region: string
  readonly state: "active" | "moving"
}

interface Cached {
  /** The highest directory version this deployment's entries have seen. */
  highest: number
  readonly homes: Map<string, Home | undefined>
}

/**
 * The tenant directory, cached per deployment. Tenants are looked up lazily,
 * and a tenant with no row is cached as absent, meaning the primary region.
 * Every poll rereads only rows above the highest version held; versions are
 * stamped in commit order, so none is skipped. Nothing here writes a row.
 */
export const directory = Effect.fnUntraced(function* (options: EdgeOptions) {
  const sql = yield* SqlClient.SqlClient
  const deployments = new Map<string, Cached>()

  const cachedFor = Effect.fnUntraced(function* (deployment: string) {
    const existing = deployments.get(deployment)

    if (existing !== undefined) return existing

    // The version is read before any entry, so a change after it is reread by the next poll.
    const [row] = yield* sql<{ readonly highest: number }>`
      SELECT coalesce(max(version), 0)::float8 AS highest
      FROM tenant_directory WHERE deployment_id = ${deployment}
    `.pipe(Effect.orDie)

    const created: Cached = { highest: row?.highest ?? 0, homes: new Map() }
    deployments.set(deployment, created)

    return created
  })

  const poll = Effect.suspend(() =>
    Effect.forEach(
      [...deployments.entries()],
      ([deployment, cached]) =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly tenant: string
            readonly region: string
            readonly state: "active" | "moving"
            readonly version: number
          }>`
          SELECT tenant, region, state, version::float8 AS version
          FROM tenant_directory WHERE deployment_id = ${deployment} AND version > ${cached.highest}
        `

          for (const { tenant, region, state, version } of rows) {
            if (cached.homes.has(tenant)) cached.homes.set(tenant, { region, state })

            cached.highest = Math.max(cached.highest, version)
          }
        }),
      { discard: true },
    ),
  )

  yield* poll.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Tenant directory poll failed", cause)),
    Effect.repeat(Schedule.spaced(options.pollEvery)),
    Effect.forkScoped,
  )

  return {
    /** The tenant's home, or `undefined` for a tenant that lives in the primary region. */
    home: Effect.fnUntraced(function* (deployment: string, tenant: string) {
      const cached = yield* cachedFor(deployment)

      if (cached.homes.has(tenant)) return cached.homes.get(tenant)

      const [row] = yield* sql<Home>`
        SELECT region, state FROM tenant_directory
        WHERE deployment_id = ${deployment} AND tenant = ${tenant}
      `.pipe(Effect.orDie)

      cached.homes.set(tenant, row)

      return row
    }),
  }
})
