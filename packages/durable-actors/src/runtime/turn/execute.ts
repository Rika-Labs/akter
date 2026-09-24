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
import { compress, decompress } from "../storage/codec.ts"
import { RetryTurn, TurnHooks } from "./hooks.ts"
import { checkReceipt, OutcomeJson, payloadHash, type StoredReceipt } from "./receipt.ts"

/**
 * What one activation remembers between turns. `generation` is the
 * fenced authority epoch it acquired; `state` is the committed state it last
 * read or wrote. The generation fence proves no other writer committed since,
 * so a cached activation skips the state read. Only a commit replaces either.
 */
export interface ActivationCache {
  generation: string | undefined
  state: ReadonlyMap<string, string> | undefined
}

/** A fresh activation has acquired no generation and read no state. */
export const emptyActivationCache = (): ActivationCache => ({
  generation: undefined,
  state: undefined,
})

interface Admission {
  readonly generation: string
  readonly created: boolean
  readonly caller_key: string | null
  readonly command: string | null
  readonly payload_hash: string | null
  readonly outcome: string | null
}

/**
 * One command turn inside one framework transaction: an admission statement
 * (generation fence plus receipt lookup), the handler in memory, and a commit
 * statement writing dirty state, the creation marker, and the receipt.
 */
export const executeTurn = Effect.fnUntraced(function* (
  request: Request,
  command: RegisteredCommand,
  cache: ActivationCache,
  routingKey: bigint,
  policy: TurnPolicy,
) {
  const sql = yield* SqlClient.SqlClient
  const hooks = yield* TurnHooks
  const hash = yield* payloadHash(request.payload).pipe(Effect.orDie)
  const { tenant, actor, id } = request.ref

  const actorRow = sql`routing_key = ${routingKey} AND tenant_id = ${tenant} AND actor_type = ${actor} AND actor_id = ${id}`

  const transaction = Effect.gen(function* () {
    yield* sql`SELECT set_config('lock_timeout', ${`${policy.lockWaitMs}ms`}, true),
      set_config('statement_timeout', ${`${policy.executionMs}ms`}, true)`
    yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
      VALUES (${routingKey}, ${tenant}, ${actor}, ${id}) ON CONFLICT DO NOTHING`

    const admission = (yield* sql<Admission>`
      SELECT g.generation::text AS generation, g.created,
        r.caller_key, r.command, r.payload_hash, r.outcome
      FROM actor_generations g
      LEFT JOIN actor_receipts r ON r.routing_key = g.routing_key AND r.tenant_id = g.tenant_id
        AND r.actor_type = g.actor_type AND r.actor_id = g.actor_id AND r.command_id = ${request.commandId}
      WHERE g.routing_key = ${routingKey} AND g.tenant_id = ${tenant}
        AND g.actor_type = ${actor} AND g.actor_id = ${id}
      FOR UPDATE OF g`)[0]!

    let current = admission.generation

    if (cache.generation === undefined) {
      current = (yield* sql<{ generation: string }>`
        UPDATE actor_generations SET generation = generation + 1 WHERE ${actorRow}
        RETURNING generation::text AS generation`)[0]!.generation
    } else if (cache.generation !== current) {
      return yield* Effect.die(RetryTurn.make({ message: "Stale actor generation" }))
    }

    if (admission.outcome !== null) {
      const outcome = yield* checkReceipt(request, hash, admission as StoredReceipt)

      return { outcome, generation: current, state: cache.state }
    }

    if (command.internal && !Schema.is(System)(request.caller))
      return yield* Effect.die(new Error("Internal commands require a System caller"))

    if (
      policy.createdBy !== undefined &&
      !admission.created &&
      policy.createdBy !== request.command
    )
      return yield* ActorError.make({ reason: NotCreated.make({}) })

    const committed =
      cache.state ??
      new Map(
        (yield* sql<{ key: string; value: Uint8Array }>`
          SELECT key, value FROM actor_state WHERE ${actorRow}`).map(({ key, value }) => [
          key,
          decompress(value),
        ]),
      )

    const business = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* hooks.at("beforeHandler", request)

          return yield* command.run(request, [...committed])
        }),
      )
      .pipe(Effect.catchIf(SqlError.isSqlError, Effect.die), Effect.result)

    const result: BusinessResult = Result.isSuccess(business) ? business.success : business.failure
    const next = new Map(committed)

    for (const [key, value] of result.state) {
      next.set(key, value)
      yield* sql`INSERT INTO actor_state (routing_key, tenant_id, actor_type, actor_id, key, value)
        VALUES (${routingKey}, ${tenant}, ${actor}, ${id}, ${key}, ${compress(value)})
        ON CONFLICT (routing_key, tenant_id, actor_type, actor_id, key) DO UPDATE SET value = EXCLUDED.value`
    }

    if (result.complete) {
      const written = new Set(result.state.map(([key]) => key))

      for (const key of committed.keys())
        if (!written.has(key)) {
          next.delete(key)
          yield* sql`DELETE FROM actor_state WHERE ${actorRow} AND key = ${key}`
        }
    }

    const creates =
      Outcome.guards.Success(result.outcome) &&
      policy.createdBy === request.command &&
      !admission.created

    if (creates) yield* sql`UPDATE actor_generations SET created = true WHERE ${actorRow}`
    const encoded = yield* Schema.encodeEffect(OutcomeJson)(result.outcome).pipe(Effect.orDie)
    yield* sql`INSERT INTO actor_receipts (routing_key, tenant_id, actor_type, actor_id, command_id, command, payload_hash, caller_key, outcome, expires_at_ms)
      VALUES (${routingKey}, ${tenant}, ${actor}, ${id}, ${request.commandId}, ${request.command}, ${hash}, ${callerKey(request.caller)}, ${encoded}, ${commandTimes(request.commandId).expiresAt})`
    yield* hooks.at("beforeCommit", request)

    return { outcome: result.outcome, generation: current, state: next }
  })

  const done = yield* sql.withTransaction(transaction).pipe(
    Effect.interruptible,
    Effect.timeoutOrElse({
      duration: policy.executionMs,
      orElse: () => Effect.die(RetryTurn.make({ message: "Command execution timeout" })),
    }),
    Effect.catchIf(SqlError.isSqlError, Effect.die),
    // A failed or unknown commit leaves nothing the cache can trust.
    Effect.onError(() =>
      Effect.sync(() => {
        cache.state = undefined
      }),
    ),
  )

  cache.generation = done.generation
  cache.state = done.state

  return done.outcome
})
