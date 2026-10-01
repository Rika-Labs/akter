import { Clock, Duration, Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { EdgeOptions } from "../config.ts"

/** A deployment reached by host, its primary region, and whether it may run with no runners. */
export interface Deployment {
  readonly id: string
  readonly primaryRegion: string
  readonly scaleToZero: boolean
}

/** The request host without its port, lowercase, as `deployment_host` stores it. */
export const hostOf = (value: string) => value.replace(/:\d+$/, "").toLowerCase()

/**
 * Maps a request host to its deployment, rereading each host at most once a
 * poll interval; an unknown host is remembered as unknown for as long.
 */
export const hosts = Effect.fnUntraced(function* (options: EdgeOptions) {
  const sql = yield* SqlClient.SqlClient
  const pollMs = Duration.toMillis(options.pollEvery)

  const cache = new Map<
    string,
    { readonly at: number; readonly deployment: Deployment | undefined }
  >()

  return {
    resolve: Effect.fnUntraced(function* (host: string) {
      const now = yield* Clock.currentTimeMillis
      const cached = cache.get(host)

      if (cached !== undefined && now - cached.at < pollMs) return cached.deployment

      const [row] = yield* sql<Deployment>`
        SELECT d.id, d.primary_region AS "primaryRegion", d.scale_to_zero AS "scaleToZero"
        FROM deployment_host h JOIN deployment d ON d.id = h.deployment_id
        WHERE h.host = ${host}
      `.pipe(Effect.orDie)

      cache.set(host, { at: now, deployment: row })

      return row
    }),
  }
})
