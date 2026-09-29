import { KEY_REFRESH_PATH, ASSERTION_HEADER } from "@durable-actors/core"
import { Effect, Ref, Schedule } from "effect"
import { type HttpClient, HttpClientRequest } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import type { EdgeOptions } from "../config.ts"
import type { KeyRing } from "./keys.ts"

interface Runner {
  readonly deployment: string
  readonly url: string
  readonly basePath: string
}

const runnerKey = (runner: Runner) => `${runner.deployment}\n${runner.url}\n${runner.basePath}`

/**
 * Pushes a key-set refresh to every ready runner when the control plane
 * revokes an edge key, so runners refuse it within one edge poll instead of
 * their own polling interval. A runner stays pending, and is pushed again on
 * every poll, until it accepts the push or stops being ready. Revocations
 * already in place at startup were pushed by the edge that saw them, and
 * runners' polling covers any it missed.
 *
 * `Actor.serve` ignores trailing slashes on its base path, so `/` is the root.
 * Every ready runner is owed a push after a new revocation; one that stopped
 * being ready is not.
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

  const readyRunners = sql<Runner>`
    SELECT deployment_id AS deployment, url, base_path AS "basePath"
    FROM deployment_runner WHERE ready
  `

  const seen = yield* Ref.make(yield* revokedKids.pipe(Effect.orDie))
  const pending = yield* Ref.make<ReadonlySet<string>>(new Set())

  /** Whether the runner accepted the push. */
  const pushOne = Effect.fnUntraced(function* (runner: Runner) {
    const token = yield* keys.signRefresh(runner.deployment)

    if (token === undefined) {
      yield* Effect.logWarning("No edge key can sign a refresh push")

      return false
    }

    const basePath = runner.basePath.replace(/\/+$/, "")

    const request = HttpClientRequest.post(`${runner.url}${basePath}${KEY_REFRESH_PATH}`, {
      headers: { [ASSERTION_HEADER]: token },
    })

    const response = yield* client.execute(request)

    if (response.status === 204) return true

    yield* Effect.logWarning(`Runner ${runner.url} answered a refresh push with ${response.status}`)

    return false
  })

  const poll = Effect.gen(function* () {
    const revoked = yield* revokedKids
    const previous = yield* Ref.get(seen)
    const runners = yield* readyRunners
    const newlyRevoked = [...revoked].some((kid) => !previous.has(kid))
    const waiting = yield* Ref.get(pending)

    const owed = runners.filter((runner) => newlyRevoked || waiting.has(runnerKey(runner)))

    yield* Ref.set(seen, revoked)

    const refused = yield* Effect.filter(
      owed,
      (runner) =>
        pushOne(runner).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`Refresh push to ${runner.url} failed`, cause).pipe(Effect.as(false)),
          ),
          Effect.map((accepted) => !accepted),
        ),
      { concurrency: 16 },
    )

    yield* Ref.set(pending, new Set(refused.map(runnerKey)))
  })

  yield* poll.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Edge key revocation poll failed", cause)),
    Effect.repeat(Schedule.spaced(options.pollEvery)),
    Effect.forkScoped,
  )
})
