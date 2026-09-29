import { KEY_REFRESH_PATH, ASSERTION_HEADER } from "@durable-actors/core"
import { Effect, Ref, Schedule } from "effect"
import { type HttpClient, HttpClientRequest } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import type { EdgeOptions } from "../config.ts"
import type { KeyRing } from "./keys.ts"

/**
 * Pushes a key-set refresh to every ready runner when the control plane
 * revokes an edge key, so runners refuse it within one edge poll instead of
 * their own polling interval. Revocations already in place at startup were
 * pushed by the edge that saw them, and runners' polling covers any it missed.
 */
export const revocationPush = Effect.fnUntraced(function* (
  options: EdgeOptions,
  keys: KeyRing,
  client: HttpClient.HttpClient,
) {
  const sql = yield* SqlClient.SqlClient

  const revokedKids = sql<{ readonly kid: string }>`
    SELECT kid FROM edge_key WHERE revoked_at IS NOT NULL
  `.pipe(Effect.map((rows) => new Set(rows.map(({ kid }) => kid))))

  const seen = yield* Ref.make(yield* revokedKids.pipe(Effect.orDie))

  const pushOne = Effect.fnUntraced(function* (runner: {
    readonly deployment: string
    readonly url: string
    readonly basePath: string
  }) {
    const token = yield* keys.signRefresh(runner.deployment)

    if (token === undefined) return yield* Effect.logWarning("No edge key can sign a refresh push")

    const request = HttpClientRequest.post(`${runner.url}${runner.basePath}${KEY_REFRESH_PATH}`, {
      headers: { [ASSERTION_HEADER]: token },
    })

    const response = yield* client.execute(request)

    if (response.status !== 204)
      yield* Effect.logWarning(
        `Runner ${runner.url} answered a refresh push with ${response.status}`,
      )
  })

  const poll = Effect.gen(function* () {
    const revoked = yield* revokedKids
    const previous = yield* Ref.get(seen)

    yield* Ref.set(seen, revoked)

    if ([...revoked].every((kid) => previous.has(kid))) return

    const runners = yield* sql<{
      readonly deployment: string
      readonly url: string
      readonly basePath: string
    }>`
      SELECT deployment_id AS deployment, url, base_path AS "basePath"
      FROM deployment_runner WHERE ready
    `

    yield* Effect.forEach(
      runners,
      (runner) =>
        pushOne(runner).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`Refresh push to ${runner.url} failed`, cause),
          ),
        ),
      { concurrency: 16, discard: true },
    )
  })

  yield* poll.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Edge key revocation poll failed", cause)),
    Effect.repeat(Schedule.spaced(options.pollEvery)),
    Effect.forkScoped,
  )
})
