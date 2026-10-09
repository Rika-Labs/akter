import { Context, type Crypto, Effect, Semaphore } from "effect"
import { Sharding } from "effect/cluster"
import { SqlClient, SqlError } from "effect/sql"
import { ActorError, ActorUnavailable, InvalidInput, NotCreated, Timeout } from "../errors/actor.ts"
import { type InternalActors } from "./actors.ts"
import { Outcome, type Request } from "./request.ts"
import {
  ReadRequiresDatabase,
  type QueryRegistration,
  type Registration,
  type WorkflowStatus,
} from "./members.ts"
import type { ActorRef } from "../identity/caller.ts"
import type { Holder } from "./connections/holder.ts"
import type { ReadSet } from "./connections/reads.ts"
import type { ActivationCache } from "./storage/generation.ts"
import { watchStream } from "./connections/watch.ts"
import { caughtUp, QueryPool } from "./database/replica.ts"
import { withTenant } from "./database/tenancy.ts"
import { replayEvents } from "./events/replay.ts"
import { decompress, routingKey } from "./storage/codec.ts"
import { accountsUsage, UsageAccounting } from "./telemetry/usage.ts"
import { decodeResult } from "./workflows/engine.ts"

/**
 * The runtime's reads of committed rows outside any turn: whether an actor
 * exists, a query member's answer, and a workflow execution's status. Each
 * read runs on the caller's node without an activation, generation fence,
 * receipt, or command id, rechecks access after it reads, and fails an
 * unreachable database as `ActorUnavailable`.
 */
/** Watch reruns one runner runs at once; another waits for a place. */
const WATCH_RERUNS = 64

export const committedReads = ({
  registrations,
  queryRegistrations,
  services,
  allow,
  primary,
  replica,
  holder,
  cached,
}: {
  readonly registrations: ReadonlyMap<string, Registration>
  readonly queryRegistrations: ReadonlyMap<string, QueryRegistration>
  readonly services: Context.Context<SqlClient.SqlClient | Crypto.Crypto | Sharding.Sharding>
  readonly allow: (
    request: Request,
    kind?: "command" | "query" | "stream",
  ) => Effect.Effect<void, ActorError>
  readonly primary: SqlClient.SqlClient
  readonly replica: SqlClient.SqlClient | undefined
  /** This runner's connection holder, where a watch parks. */
  readonly holder: Holder
  readonly cached: (ref: ActorRef) => Effect.Effect<ActivationCache | undefined>
}): Pick<InternalActors["Service"], "exists" | "query" | "watch" | "pollWorkflow"> => {
  const reruns = Semaphore.makeUnsafe(WATCH_RERUNS)
  const queryPool = Context.get(services, QueryPool)
  const usage = Context.getUnsafe(services, UsageAccounting)
  const accounting = accountsUsage(usage) ? usage : undefined

  const exists = Effect.fnUntraced(
    function* (ref: ActorRef) {
      const registration = registrations.get(ref.actor)

      if (registration === undefined)
        return yield* ActorError.make({
          reason: ActorUnavailable.make({ cause: new Error("Actor not registered") }),
        })

      const sql = yield* SqlClient.SqlClient

      const key = routingKey({ ref, placement: registration.placement })

      const rows = yield* sql`
          SELECT 1 FROM actor_generations
          WHERE routing_key = ${key}
            AND tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`.pipe(
        withTenant(ref.tenant),
      )

      return rows.length > 0
    },
    Effect.provideContext(services),
    Effect.catchIf(SqlError.isSqlError, (cause) =>
      Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
    ),
  )

  /**
   * A query's answer. A watch's rerun passes `reads` and skips both access
   * checks, because its session was authorized at open and is reauthorized
   * on its bound; the recorder fills `reads`.
   */
  const query = Effect.fnUntraced(
    function* (request: Request, minVersion?: string, reads?: ReadSet) {
      const registration = queryRegistrations.get(request.ref.actor)
      const query = registration?.queries.get(request.command)

      if (registration === undefined || query === undefined)
        return yield* ActorError.make({
          reason: ActorUnavailable.make({ cause: new Error("Query not registered") }),
        })

      if (reads === undefined) yield* allow(request, "query")
      const key = routingKey({ ref: request.ref, placement: registration.placement })

      const read = (client: SqlClient.SqlClient) =>
        Effect.gen(function* () {
          const rows = yield* client<{
            head: string | null
            key: string | null
            value: Uint8Array | null
          }>`
              SELECT event_sequence::text AS head, NULL AS key, NULL::bytea AS value
              FROM actor_generations
              WHERE routing_key = ${key} AND tenant_id = ${request.ref.tenant}
                AND actor_type = ${request.ref.actor} AND actor_id = ${request.ref.id}
              UNION ALL
              SELECT NULL, key, value
              FROM actor_state
              WHERE routing_key = ${key} AND tenant_id = ${request.ref.tenant}
                AND actor_type = ${request.ref.actor} AND actor_id = ${request.ref.id}`

          let head: string | undefined
          const state: Array<readonly [string, string]> = []

          for (const row of rows)
            if (row.head !== null) head = row.head
            else state.push([row.key!, decompress(row.value!)])

          if (head === undefined) state.length = 0

          const cursor = head ?? "0"

          const outcome = yield* query.run(
            request,
            state,
            cursor,
            (tag, after, limit) =>
              replayEvents(request.ref, key, [tag], after, BigInt(cursor), limit).pipe(
                Effect.catchIf(SqlError.isSqlError, Effect.die),
                Effect.provideService(SqlClient.SqlClient, client),
                Effect.provideContext(services),
              ),
            reads,
          )

          if (Outcome.guards.Defect(outcome) && SqlError.isSqlError(outcome.cause))
            return yield* outcome.cause

          return outcome
        }).pipe(withTenant(request.ref.tenant), Effect.provideService(SqlClient.SqlClient, client))

      const owned = registration.tables.length > 0 || registration.blobs.length > 0
      const local = owned ? primary : (queryPool ?? primary)

      const outcome = yield* Effect.gen(function* () {
        const cache = owned || reads !== undefined ? undefined : yield* cached(request.ref)
        const snapshot = cache?.committed

        if (
          snapshot !== undefined &&
          snapshot.generation === cache!.generation &&
          snapshot.state === cache!.state &&
          (minVersion === undefined || BigInt(snapshot.version) >= BigInt(minVersion))
        ) {
          const answer = yield* query.run(
            request,
            [...snapshot.state],
            snapshot.head,
            () => Effect.die(new ReadRequiresDatabase()),
            undefined,
            snapshot.version,
          )

          if (!(Outcome.guards.Defect(answer) && answer.cause instanceof ReadRequiresDatabase))
            return answer
        }

        if (owned || replica === undefined) return yield* read(local)

        if (minVersion !== undefined) {
          const ready = yield* caughtUp(replica, minVersion).pipe(
            Effect.catchIf(SqlError.isSqlError, () => Effect.succeed(false)),
          )

          if (!ready) return yield* read(local)
        }

        return yield* read(replica).pipe(Effect.catchIf(SqlError.isSqlError, () => read(local)))
      }).pipe(
        Effect.timeoutOrElse({
          duration: registration.timeoutMs,
          orElse: () =>
            Effect.fail(
              ActorError.make({ reason: Timeout.make({ commandId: request.commandId }) }),
            ),
        }),
      )

      if (reads === undefined) {
        yield* allow(request, "query")

        if (accounting !== undefined && !Outcome.guards.Defect(outcome))
          yield* accounting.read({
            ref: request.ref,
            requestToken: request.usageToken,
            watch: false,
            sql: primary,
          })
      }

      return outcome
    },
    Effect.provideContext(services),
    Effect.catchIf(SqlError.isSqlError, (cause) =>
      Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
    ),
  )

  return {
    exists,
    query: (request, minVersion) => query(request, minVersion),
    watch: (request, { minVersion, expiresAt }) =>
      Effect.gen(function* () {
        const registration = registrations.get(request.ref.actor)
        const watched = queryRegistrations.get(request.ref.actor)?.queries.get(request.command)

        if (registration === undefined || watched === undefined)
          return yield* ActorError.make({
            reason: ActorUnavailable.make({ cause: new Error("Query not registered") }),
          })

        if (!watched.watch)
          return yield* ActorError.make({ reason: InvalidInput.make({ code: "not_watchable" }) })

        if (!(yield* exists(request.ref)))
          return yield* ActorError.make({ reason: NotCreated.make({}) })

        const rerun = (version: () => string | undefined, reads: ReadSet) =>
          reruns.withPermit(Effect.suspend(() => query(request, version(), reads)))

        const { usageToken } = request
        let counted = false

        return yield* watchStream({
          holder,
          request,
          minIntervalMs: registration.policy.watch.minIntervalMs,
          reconcileMs: registration.policy.watch.reconcileMs,
          minVersion,
          expiresAt,
          rerun:
            accounting === undefined || usageToken === undefined
              ? rerun
              : (version, reads) =>
                  rerun(version, reads).pipe(
                    Effect.tap((outcome) =>
                      counted || Outcome.guards.Defect(outcome)
                        ? Effect.void
                        : allow(request, "query").pipe(
                            Effect.andThen(
                              accounting.read({
                                ref: request.ref,
                                requestToken: usageToken,
                                watch: true,
                                sql: primary,
                              }),
                            ),
                            Effect.tap(() => Effect.sync(() => void (counted = true))),
                            Effect.catchIf(SqlError.isSqlError, (cause) =>
                              Effect.fail(
                                ActorError.make({ reason: ActorUnavailable.make({ cause }) }),
                              ),
                            ),
                          ),
                    ),
                  ),
        })
      }),
    pollWorkflow: Effect.fnUntraced(
      function* (request: Request) {
        const registration =
          registrations.get(request.ref.actor) ?? queryRegistrations.get(request.ref.actor)

        if (registration === undefined)
          return yield* ActorError.make({
            reason: ActorUnavailable.make({ cause: new Error("Actor not registered") }),
          })

        yield* allow(request)
        const sql = yield* SqlClient.SqlClient

        const key = routingKey({ ref: request.ref, placement: registration.placement })

        const [row] = yield* sql<{ status: string; result: Uint8Array | null }>`
          SELECT status, result FROM actor_workflow_executions
          WHERE routing_key = ${key}
            AND execution_id = ${request.payload} AND tenant_id = ${request.ref.tenant}
            AND actor_type = ${request.ref.actor} AND actor_id = ${request.ref.id}
            AND workflow = ${request.command}`.pipe(withTenant(request.ref.tenant))

        yield* allow(request)

        if (row === undefined) return undefined

        return {
          finished: row.status === "finished",
          result: row.result === null ? undefined : yield* decodeResult(row.result),
        } satisfies WorkflowStatus
      },
      Effect.provideContext(services),
      Effect.catchIf(SqlError.isSqlError, (cause) =>
        Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
      ),
    ),
  }
}
