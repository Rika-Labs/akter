import { Context, Crypto, Effect, Layer, Schema, type Scope } from "effect"
import { HttpRouter } from "effect/http"
import { SqlClient } from "effect/sql"
import { type Actors, Unauthorized } from "../../../../packages/akter/src/index.ts"
import type { InternalActors } from "../../../../packages/akter/src/runtime/actors.ts"
import { OperatorAuth } from "../../../../packages/akter/src/runtime/operators/auth.ts"
import type { Capability } from "../../../../packages/akter/src/runtime/operators/grants.ts"
import { Operators } from "../../../../packages/akter/src/runtime/operators/routes.ts"
import { bearerToken } from "../../../../packages/akter/src/serve/auth.ts"
import { ActorTest } from "../../../../packages/akter/src/testing/actor-test.ts"
import type { ConformanceEnvironment } from "../conformance.ts"

/** An operator answer: its HTTP status and decoded JSON body. */
export interface Answer {
  readonly status: number
  readonly body: unknown
}

/** What a case sees of the runtime that serves the operator routes. */
export interface Harness {
  readonly tenant: string
  /** Gives `token` a grant of these capabilities from now on. */
  readonly grant: (token: string, capabilities: ReadonlyArray<Capability>) => Effect.Effect<void>
  /** Sends one operator request with `token` as its bearer credential. */
  readonly send: (
    method: "GET" | "POST",
    path: string,
    token: string | undefined,
    body?: Schema.Json,
  ) => Effect.Effect<Answer>
  readonly deadLetters: Effect.Effect<
    ReadonlyArray<{ job_id: string; job: string; ambiguous: boolean }>
  >
  /**
   * Every audit row in the order the requests wrote them. `at_ms` has
   * millisecond resolution and back-to-back requests can share one, so ties
   * break by the writing transaction's id, which grows with each sequential
   * request, never by the random audit id.
   */
  readonly audit: Effect.Effect<ReadonlyArray<AuditRow>>
}

/** One `durable.operator_audit` row. */
export interface AuditRow {
  readonly operator: string
  readonly action: string
  readonly actor_id: string | null
  readonly target: string | null
  readonly capability: string | null
  readonly reason: string | null
  readonly outcome: string
}

/**
 * A runtime of its own on a fresh database, running `live` and serving
 * `Operators.serve` with these tokens through an in-memory web handler.
 * `reset` runs first, so a fixture starts each case clean. The retry window
 * is the suite's, so command ids the suite runtime mints are valid here, and
 * `grants` starts from `tokens` so a case can add one once it knows the ids
 * it names.
 */
export const operatorHarness = <A, E>({
  environment,
  live,
  reset,
  tokens,
  body,
}: {
  readonly environment: ConformanceEnvironment
  readonly live: Layer.Layer<never, never, InternalActors>
  readonly reset: () => void
  readonly tokens: Record<string, ReadonlyArray<Capability>>
  readonly body: (
    harness: Harness,
  ) => Effect.Effect<A, E, Actors | ActorTest | SqlClient.SqlClient | Crypto.Crypto | Scope.Scope>
}) =>
  environment.run(
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto
      const database = yield* environment.freshDatabase

      reset()

      const services = yield* Layer.buildWithMemoMap(
        live.pipe(
          Layer.provideMerge(
            ActorTest.layer({
              database,
              retryWindowMs: 60_000,
            }),
          ),
          Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
          Layer.orDie,
        ),
        yield* Layer.makeMemoMap,
        yield* Effect.scope,
      )

      const grants = new Map(
        Object.entries(tokens).map(([token, capabilities]) => [
          token,
          { operator: `op-${token}`, capabilities },
        ]),
      )

      const auth = OperatorAuth.make((request) =>
        Effect.flatMap(bearerToken(request), (token) => {
          const grant = grants.get(token)

          return grant === undefined
            ? Effect.fail(Unauthorized.make({ code: "invalid_credentials" }))
            : Effect.succeed(grant)
        }),
      )

      const web = HttpRouter.toWebHandler(
        Operators.serve({ auth }).pipe(Layer.provide(Layer.succeedContext(services))),
        { disableLogger: true },
      )

      yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))

      const sql = Context.get(services, SqlClient.SqlClient)
      const tenant = Context.get(services, ActorTest).tenant

      const harness: Harness = {
        tenant,
        grant: (token, capabilities) =>
          Effect.sync(() => {
            grants.set(token, { operator: `op-${token}`, capabilities })
          }),
        send: (method, path, token, payload) =>
          Effect.gen(function* () {
            const encoded =
              payload === undefined ? undefined : yield* encodeJson(payload).pipe(Effect.orDie)

            const response = yield* Effect.promise(() =>
              web.handler(
                encoded === undefined
                  ? new Request(`http://runner${path}`, {
                      method,
                      headers: requestHeaders(token, encoded),
                    })
                  : new Request(`http://runner${path}`, {
                      method: "POST",
                      headers: requestHeaders(token, encoded),
                      body: encoded,
                    }),
              ),
            )

            const text = yield* Effect.promise(() => response.text())

            return {
              status: response.status,
              body: text.length === 0 ? null : yield* decodeJson(text).pipe(Effect.orDie),
            }
          }),
        deadLetters: sql<{ job_id: string; job: string; ambiguous: boolean }>`
          SELECT job_id, job, ambiguous FROM actor_dead_letters ORDER BY dead_at_ms`.pipe(
          Effect.orDie,
        ),
        audit: sql<AuditRow>`SELECT operator, action, actor_id, target, capability, reason, outcome
          FROM actor_operator_audit ORDER BY at_ms, xmin::text::bigint`.pipe(Effect.orDie),
      }

      return yield* body(harness).pipe(Effect.provideContext(services))
    }),
  )

const requestHeaders = (token: string | undefined, body: string | undefined) => {
  const headers = new Headers()

  if (token !== undefined) headers.set("authorization", `Bearer ${token}`)

  if (body !== undefined) headers.set("content-type", "application/json")

  return headers
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
