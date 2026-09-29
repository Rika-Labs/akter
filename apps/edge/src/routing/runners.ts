import { Clock, Duration, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { EdgeOptions } from "../config.ts"

/**
 * The ready runners of a deployment in a region, in the order to try them:
 * rotated on every call, so requests spread across the pool. The edge holds
 * no shard map; any runner routes to the owner through the cluster.
 */
export const runners = Effect.fnUntraced(function* (options: EdgeOptions) {
  const sql = yield* SqlClient.SqlClient
  const pollMs = Duration.toMillis(options.pollEvery)
  const cache = new Map<string, { readonly at: number; readonly urls: ReadonlyArray<string> }>()
  let turn = 0

  return {
    ready: Effect.fnUntraced(function* (deployment: string, region: string) {
      const now = yield* Clock.currentTimeMillis
      const key = `${deployment}\n${region}`
      let cached = cache.get(key)

      if (cached === undefined || now - cached.at >= pollMs) {
        const rows = yield* sql<{ readonly url: string }>`
          SELECT url FROM deployment_runner
          WHERE deployment_id = ${deployment} AND region = ${region} AND ready
          ORDER BY url
        `.pipe(Effect.orDie)

        cached = { at: now, urls: rows.map(({ url }) => url) }
        cache.set(key, cached)
      }

      const start = turn++ % Math.max(1, cached.urls.length)

      return [...cached.urls.slice(start), ...cached.urls.slice(0, start)]
    }),
  }
})
