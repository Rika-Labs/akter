import { Clock, Deferred, Duration, Effect, Exit, Option, Schedule } from "effect"
import { type HttpClient, HttpClientRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import type { EdgeOptions } from "../config.ts"

/** How often a cold start rereads the registered runners and probes them. */
const PROBE_EVERY = "100 millis"

/** How long one readiness probe may take before the runner counts as not ready yet. */
const PROBE_TIMEOUT = "1 second"

/**
 * The ready runners of a deployment in a region, in the order to try them:
 * rotated on every call, so requests spread across the pool. The edge holds
 * no shard map; any runner routes to the owner through the cluster.
 *
 * Forwarding keeps the client's path as it is: a deployment's host serves the
 * same routes as its runners, base path included, and the assertion binds that
 * path. `base_path` is where the edge pushes key-set refreshes and probes a
 * starting runner's readiness, which no client request names.
 *
 * `coldStart` serves a region with no ready runner. It asks the provider for
 * one through `runner_wake` once, then probes each registered runner's
 * `GET <base_path>/ready` until one answers `200`, because a provider
 * registers a runner as soon as it has an address, before it can serve. It
 * asks only once because the provider deletes the row when it starts a
 * runner, and asking again before that runner registers would start a second
 * one. It gives up after `coldStartTimeout` with no runners, and the next
 * request asks again. Every request that finds the region empty on this edge
 * waits on the same cold start, so a burst asks once.
 */
export const runners = Effect.fnUntraced(function* (
  options: EdgeOptions,
  client: HttpClient.HttpClient,
) {
  const sql = yield* SqlClient.SqlClient
  const pollMs = Duration.toMillis(options.pollEvery)
  const cache = new Map<string, { readonly at: number; readonly urls: ReadonlyArray<string> }>()
  const starting = new Map<string, Deferred.Deferred<ReadonlyArray<string>>>()
  let turn = 0

  const keyOf = (deployment: string, region: string) => `${deployment}\n${region}`

  const rotated = (urls: ReadonlyArray<string>) => {
    const start = turn++ % Math.max(1, urls.length)

    return [...urls.slice(start), ...urls.slice(0, start)]
  }

  const answersReady = (url: string, basePath: string) =>
    client.execute(HttpClientRequest.get(`${url}${basePath.replace(/\/+$/, "")}/ready`)).pipe(
      Effect.map((response) => response.status === 200),
      Effect.timeoutOption(PROBE_TIMEOUT),
      Effect.map(Option.getOrElse(() => false)),
      Effect.orElseSucceed(() => false),
    )

  const probe = Effect.fnUntraced(function* (deployment: string, region: string) {
    const registered = yield* sql<{ readonly url: string; readonly basePath: string }>`
      SELECT url, base_path AS "basePath" FROM deployment_runner
      WHERE deployment_id = ${deployment} AND region = ${region} AND ready
      ORDER BY url
    `

    const answered = yield* Effect.filter(
      registered,
      ({ url, basePath }) => answersReady(url, basePath),
      { concurrency: "unbounded" },
    )

    return answered.map(({ url }) => url)
  })

  const wake = Effect.fnUntraced(function* (deployment: string, region: string) {
    yield* sql`
      INSERT INTO runner_wake (deployment_id, region) VALUES (${deployment}, ${region})
      ON CONFLICT (deployment_id, region) DO UPDATE SET requested_at = now()
    `.pipe(Effect.orDie)

    const urls = yield* probe(deployment, region).pipe(
      Effect.orDie,
      Effect.repeat({
        schedule: Schedule.spaced(PROBE_EVERY),
        until: (found) => found.length > 0,
      }),
      Effect.timeoutOption(options.coldStartTimeout),
      Effect.map(Option.getOrElse((): ReadonlyArray<string> => [])),
    )

    if (urls.length > 0)
      cache.set(keyOf(deployment, region), { at: yield* Clock.currentTimeMillis, urls })

    return urls
  })

  return {
    ready: Effect.fnUntraced(function* (deployment: string, region: string) {
      const now = yield* Clock.currentTimeMillis
      const key = keyOf(deployment, region)
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

      return rotated(cached.urls)
    }),
    coldStart: Effect.fnUntraced(function* (deployment: string, region: string) {
      const key = keyOf(deployment, region)
      const pending = starting.get(key)

      if (pending !== undefined) return rotated(yield* Deferred.await(pending))

      const started = Deferred.makeUnsafe<ReadonlyArray<string>>()
      starting.set(key, started)

      const urls = yield* wake(deployment, region).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            starting.delete(key)
            Deferred.doneUnsafe(started, Exit.isSuccess(exit) ? exit : Exit.succeed([]))
          }),
        ),
      )

      return rotated(urls)
    }),
  }
})
