import { Context, Crypto, Effect } from "effect"
import { Sharding } from "effect/unstable/cluster"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { ActorError, ActorUnavailable, Timeout } from "../errors/actor.ts"
import {
  type InternalActors,
  Outcome,
  type QueryRegistration,
  type Registration,
  type Request,
  type WorkflowStatus,
} from "../handles/actors.ts"
import type { ActorRef } from "../identity/caller.ts"
import { caughtUp } from "./database/replica.ts"
import { withTenant } from "./database/tenancy.ts"
import { replayEvents } from "./events/replay.ts"
import { decompress, routingKey } from "./storage/codec.ts"
import { decodeResult } from "./workflows/engine.ts"

/**
 * The runtime's reads of committed rows outside any turn: whether an actor
 * exists, a query member's answer, and a workflow execution's status. Each
 * read runs on the caller's node without an activation, generation fence,
 * receipt, or command id, rechecks access after it reads, and fails an
 * unreachable database as `ActorUnavailable`.
 */
export const committedReads = ({
  registrations,
  queryRegistrations,
  services,
  allow,
  primary,
  replica,
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
}): Pick<InternalActors["Service"], "exists" | "query" | "pollWorkflow"> => ({
  exists: Effect.fnUntraced(
    function* (ref: ActorRef) {
      const registration = registrations.get(ref.actor)

      if (registration === undefined)
        return yield* ActorError.make({
          reason: ActorUnavailable.make({ cause: new Error("Actor not registered") }),
        })

      const sql = yield* SqlClient.SqlClient

      const rows = yield* sql`
        SELECT 1 FROM actor_generations
        WHERE routing_key = ${routingKey({ ref, placement: registration.placement })}
          AND tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`.pipe(
        withTenant(ref.tenant),
      )

      return rows.length > 0
    },
    Effect.provideContext(services),
    Effect.catchIf(SqlError.isSqlError, (cause) =>
      Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
    ),
  ),
  query: Effect.fnUntraced(
    function* (request: Request, minVersion?: string) {
      const registration = queryRegistrations.get(request.ref.actor)
      const query = registration?.queries.get(request.command)

      if (registration === undefined || query === undefined)
        return yield* ActorError.make({
          reason: ActorUnavailable.make({ cause: new Error("Query not registered") }),
        })

      yield* allow(request, "query")
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

          const outcome = yield* query.run(request, state, cursor, (tag, after, limit) =>
            replayEvents(request.ref, key, [tag], after, BigInt(cursor), limit).pipe(
              Effect.catchIf(SqlError.isSqlError, Effect.die),
              Effect.provideService(SqlClient.SqlClient, client),
              Effect.provideContext(services),
            ),
          )

          if (Outcome.guards.Defect(outcome) && SqlError.isSqlError(outcome.cause))
            return yield* outcome.cause

          return outcome
        }).pipe(withTenant(request.ref.tenant), Effect.provideService(SqlClient.SqlClient, client))

      const replicated =
        replica !== undefined && registration.tables.length === 0 && registration.blobs.length === 0

      const outcome = yield* Effect.gen(function* () {
        if (!replicated) return yield* read(primary)

        if (minVersion !== undefined) {
          const ready = yield* caughtUp(replica, minVersion).pipe(
            Effect.catchIf(SqlError.isSqlError, () => Effect.succeed(false)),
          )

          if (!ready) return yield* read(primary)
        }

        return yield* read(replica).pipe(Effect.catchIf(SqlError.isSqlError, () => read(primary)))
      }).pipe(
        Effect.timeoutOrElse({
          duration: registration.timeoutMs,
          orElse: () =>
            Effect.fail(
              ActorError.make({ reason: Timeout.make({ commandId: request.commandId }) }),
            ),
        }),
      )

      yield* allow(request, "query")

      return outcome
    },
    Effect.provideContext(services),
    Effect.catchIf(SqlError.isSqlError, (cause) =>
      Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
    ),
  ),
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

      const [row] = yield* sql<{ status: string; result: Uint8Array | null }>`
        SELECT status, result FROM actor_workflow_executions
        WHERE routing_key = ${routingKey({ ref: request.ref, placement: registration.placement })}
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
})
