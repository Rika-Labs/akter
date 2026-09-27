import { Effect, Result, Schema } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { ActorError, CommandExpired, NotCreated, Unauthorized } from "../../errors/actor.ts"
import {
  type BusinessResult,
  type ConnectionLister,
  Outcome,
  type RegisteredCommand,
  type Request,
} from "../../handles/actors.ts"
import { callerKey, System } from "../../identity/caller.ts"
import { commandTimes } from "../../identity/command.ts"
import { isMintedId, provesMint } from "../../identity/mint.ts"
import type { TurnPolicy } from "../../policies/command.ts"
import { appendEvents } from "../events/append.ts"
import { compress, decompress } from "../storage/codec.ts"
import { receiptMarginMs } from "../storage/retention.ts"
import { FrameworkClock } from "./admission.ts"
import { RetryTurn, TurnHooks } from "./hooks.ts"
import { CallerJson, OutboxRuntime, writeOutbox } from "./outbox.ts"
import { checkReceipt, encodeOutcome, hashCanonical, type StoredReceipt } from "./receipt.ts"

const isSystem = Schema.is(System)

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
  readonly now: string
  readonly generation: string
  readonly created: boolean
  readonly canonical: string
  readonly caller_key: string | null
  readonly command: string | null
  readonly payload_hash: string | null
  readonly outcome: string | null
  readonly head: string
}

/**
 * True when `request` is a minted actor's creating intent: its caller carries
 * the parent's mint proof for the actor's id, and the parent's committed
 * outbox still holds that exact intent with the same payload.
 */
const committedMintIntent = Effect.fnUntraced(function* (request: Request) {
  const { caller, ref } = request

  if (!isSystem(caller) || caller.ref === undefined || !(yield* provesMint(caller, ref)))
    return false

  const sql = yield* SqlClient.SqlClient

  const rows = yield* sql<{ caller: string }>`SELECT caller FROM actor_outbox
    WHERE intent_id = ${request.commandId} AND kind = 'intent' AND tenant_id = ${ref.tenant}
      AND actor_type = ${caller.ref.actor} AND actor_id = ${caller.ref.id}
      AND target_type = ${ref.actor} AND target_id = ${ref.id} AND command = ${request.command}
      AND payload::jsonb = ${request.payload}::jsonb`

  if (rows.length === 0) return false

  const committed = yield* Schema.decodeEffect(CallerJson)(rows[0]!.caller).pipe(Effect.orDie)

  return (
    isSystem(committed) &&
    committed.ref?.tenant === caller.ref.tenant &&
    committed.ref.actor === caller.ref.actor &&
    committed.ref.id === caller.ref.id &&
    committed.mint?.commandId === caller.mint?.commandId &&
    committed.mint?.ordinal === caller.mint?.ordinal
  )
})

/**
 * One command turn inside one framework transaction: an admission statement
 * (generation fence plus receipt lookup), the handler in memory, and a commit
 * statement writing dirty state, events, the creation marker, and the receipt.
 */
export const executeTurn = Effect.fnUntraced(function* (
  request: Request,
  command: RegisteredCommand,
  cache: ActivationCache,
  routingKey: bigint,
  policy: TurnPolicy,
  mintable: boolean,
  connections?: ConnectionLister,
) {
  const sql = yield* SqlClient.SqlClient
  const hooks = yield* TurnHooks
  const { tenant, actor, id } = request.ref

  const actorRow = sql`routing_key = ${routingKey} AND tenant_id = ${tenant} AND actor_type = ${actor} AND actor_id = ${id}`

  const transaction = Effect.gen(function* () {
    // set_config runs before the row is inserted, so lock_timeout bounds the
    // insert's row waits but not the table lock taken when the statement starts;
    // statement_timeout applies from the next statement, and commandTimeout
    // bounds the whole transaction either way.
    yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
      SELECT ${routingKey}, ${tenant}, ${actor}, ${id}
      FROM (SELECT set_config('lock_timeout', ${`${policy.lockWaitMs}ms`}, true),
        set_config('statement_timeout', ${`${policy.executionMs}ms`}, true)) AS timeouts
      ON CONFLICT DO NOTHING`

    const admission = (yield* sql<Admission>`
      SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now,
        g.generation::text AS generation, g.created,
        ${request.payload}::jsonb::text AS canonical,
        r.caller_key, r.command, r.payload_hash, r.outcome, g.event_sequence::text AS head
      FROM actor_generations g
      LEFT JOIN actor_receipts r ON r.routing_key = g.routing_key AND r.tenant_id = g.tenant_id
        AND r.actor_type = g.actor_type AND r.actor_id = g.actor_id AND r.command_id = ${request.commandId}
      WHERE g.routing_key = ${routingKey} AND g.tenant_id = ${tenant}
        AND g.actor_type = ${actor} AND g.actor_id = ${id}
      FOR UPDATE OF g`)[0]!

    const hash = yield* hashCanonical(admission.canonical)

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

      return {
        outcome,
        generation: current,
        state: cache.state,
        wake: false,
        broadcasts: [],
        head: admission.head,
      }
    }

    // Admitted work still runs past expiry, but not once cleanup may have
    // pruned a receipt of this id that committed meanwhile: without it, an
    // expired external id would run again.
    if (
      request.external === true &&
      Number(admission.now) + (yield* FrameworkClock).offsetMillis() >=
        commandTimes(request.commandId).expiresAt +
          receiptMarginMs({
            keepReceiptsMs: policy.keepReceiptsMs,
            deliveryMs: policy.deliveryMs,
            retryWindowMs: (yield* OutboxRuntime).retryWindowMs,
          })
    )
      return yield* ActorError.make({
        reason: CommandExpired.make({ commandId: request.commandId }),
      })

    if (command.internal && !isSystem(request.caller))
      return yield* Effect.die(new Error("Internal commands require a System caller"))

    if (
      policy.createdBy !== undefined &&
      !admission.created &&
      policy.createdBy !== request.command
    )
      return yield* ActorError.make({ reason: NotCreated.make({}) })

    // A minted actor is created only by the relay delivering the creating
    // intent its parent's turn staged and committed: the proof binds the id to
    // the parent's command, and the parent's outbox row, which stays until its
    // delivery commits, proves that command committed the intent.
    if (
      mintable &&
      policy.createdBy === request.command &&
      !admission.created &&
      isMintedId(id) &&
      (request.external === true || !(yield* committedMintIntent(request)))
    )
      return yield* ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) })

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

          return yield* command.run(request, [...committed], connections)
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

    yield* appendEvents(request, routingKey, result.events)

    const creates =
      Outcome.guards.Success(result.outcome) &&
      policy.createdBy === request.command &&
      !admission.created

    if (creates) yield* sql`UPDATE actor_generations SET created = true WHERE ${actorRow}`
    const wake = yield* writeOutbox(routingKey, request.ref, result.outbox)
    const encoded = yield* encodeOutcome(result.outcome).pipe(Effect.orDie)
    yield* sql`INSERT INTO actor_receipts (routing_key, tenant_id, actor_type, actor_id, command_id, command, payload_hash, caller_key, outcome, expires_at_ms)
      VALUES (${routingKey}, ${tenant}, ${actor}, ${id}, ${request.commandId}, ${request.command}, ${hash}, ${callerKey(request.caller)}, ${encoded}, ${commandTimes(request.commandId).expiresAt})`
    yield* hooks.at("beforeCommit", request)

    return {
      outcome: result.outcome,
      generation: current,
      state: next,
      wake,
      broadcasts: Outcome.guards.Success(result.outcome) ? (result.broadcasts ?? []) : [],
      head: String(BigInt(admission.head) + BigInt(result.events.length)),
    }
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

  if (done.wake) yield* (yield* OutboxRuntime).wake

  return { outcome: done.outcome, broadcasts: done.broadcasts, head: done.head }
})
