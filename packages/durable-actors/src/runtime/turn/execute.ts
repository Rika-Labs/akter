import { Effect, Result, Schema } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { ActorError, NotCreated } from "../../errors/actor.ts"
import {
  type BusinessResult,
  Outcome,
  type RegisteredCommand,
  type Request,
} from "../../handles/actors.ts"
import { callerKey, System } from "../../identity/caller.ts"
import { commandTimes } from "../../identity/command.ts"
import type { TurnPolicy } from "../../policies/command.ts"
import { RetryTurn, TurnHooks } from "./hooks.ts"
import { OutcomeJson, payloadHash, resolveReceipt } from "./receipt.ts"

export const executeTurn = Effect.fnUntraced(function* (
  request: Request,
  command: RegisteredCommand,
  generation: string | undefined,
  policy: TurnPolicy,
) {
  const sql = yield* SqlClient.SqlClient
  const hooks = yield* TurnHooks
  const hash = yield* payloadHash(request.payload).pipe(Effect.orDie)

  const transaction = Effect.gen(function* () {
    yield* sql`SELECT set_config('lock_timeout', ${`${policy.lockWaitMs}ms`}, true),
      set_config('statement_timeout', ${`${policy.executionMs}ms`}, true)`
    yield* sql`INSERT INTO actor_generations (tenant_id, actor_type, actor_id)
      VALUES (${request.ref.tenant}, ${request.ref.actor}, ${request.ref.id}) ON CONFLICT DO NOTHING`

    const rows = yield* sql<{
      generation: string
      created: boolean
    }>`SELECT generation::text AS generation, created FROM actor_generations
      WHERE tenant_id = ${request.ref.tenant} AND actor_type = ${request.ref.actor} AND actor_id = ${request.ref.id} FOR UPDATE`

    let current = rows[0]!.generation

    if (generation === undefined) {
      const acquired = yield* sql<{
        generation: string
      }>`UPDATE actor_generations SET generation = generation + 1
        WHERE tenant_id = ${request.ref.tenant} AND actor_type = ${request.ref.actor} AND actor_id = ${request.ref.id}
        RETURNING generation::text AS generation`

      current = acquired[0]!.generation
    } else if (generation !== current) {
      return yield* Effect.die(RetryTurn.make({ message: "Stale actor generation" }))
    }

    const receipt = yield* resolveReceipt(request, hash)

    if (receipt !== undefined) return { outcome: receipt, generation: current }

    if (command.internal && !Schema.is(System)(request.caller))
      return yield* Effect.die(new Error("Internal commands require a System caller"))

    if (policy.createdBy !== undefined && !rows[0]!.created && policy.createdBy !== request.command)
      return yield* ActorError.make({ reason: NotCreated.make({}) })

    const business = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* hooks.at("beforeHandler", request)

          const state = yield* sql<{
            key: string
            value: string
          }>`SELECT key, value::text AS value FROM actor_state
        WHERE tenant_id = ${request.ref.tenant} AND actor_type = ${request.ref.actor} AND actor_id = ${request.ref.id}`

          const result = yield* command.run(
            request,
            state.map(({ key, value }) => [key, value]),
          )

          for (const [key, value] of result.state) {
            yield* sql`INSERT INTO actor_state (tenant_id, actor_type, actor_id, key, value)
          VALUES (${request.ref.tenant}, ${request.ref.actor}, ${request.ref.id}, ${key}, ${value}::jsonb)
          ON CONFLICT (tenant_id, actor_type, actor_id, key) DO UPDATE SET value = EXCLUDED.value`
          }

          return result
        }),
      )
      .pipe(Effect.catchIf(SqlError.isSqlError, Effect.die), Effect.result)

    const result: BusinessResult = Result.isSuccess(business) ? business.success : business.failure

    if (
      Outcome.guards.Success(result.outcome) &&
      policy.createdBy === request.command &&
      !rows[0]!.created
    )
      yield* sql`UPDATE actor_generations SET created = true
        WHERE tenant_id = ${request.ref.tenant} AND actor_type = ${request.ref.actor} AND actor_id = ${request.ref.id}`
    const encoded = yield* Schema.encodeEffect(OutcomeJson)(result.outcome).pipe(Effect.orDie)
    yield* sql`INSERT INTO actor_receipts (tenant_id, actor_type, actor_id, command_id, command, payload_hash, caller_key, outcome, expires_at_ms)
      VALUES (${request.ref.tenant}, ${request.ref.actor}, ${request.ref.id}, ${request.commandId}, ${request.command}, ${hash}, ${callerKey(request.caller)}, ${encoded}, ${commandTimes(request.commandId).expiresAt})`
    yield* hooks.at("beforeCommit", request)

    return { outcome: result.outcome, generation: current }
  })

  return yield* sql.withTransaction(transaction).pipe(
    Effect.interruptible,
    Effect.timeoutOrElse({
      duration: policy.executionMs,
      orElse: () => Effect.die(RetryTurn.make({ message: "Command execution timeout" })),
    }),
    Effect.catchIf(SqlError.isSqlError, Effect.die),
  )
})
