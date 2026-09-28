import { Context, Crypto, Effect, Schema } from "effect"
import { SqlClient, type SqlError } from "effect/unstable/sql"
import { Due, effectKey, type StagedOutbox } from "../../handles/intents.ts"
import { type ActorRef, Caller } from "../../identity/caller.ts"
import { databaseTime, FrameworkClock } from "./admission.ts"

/**
 * The due-work bucket: the top eight bits of `routing_key`. Every runner's
 * relay probes each bucket's `(bucket, kind, due_at_ms)` index range, so actors
 * with nothing due are never read.
 */
export const bucketOf = (routingKey: bigint) => Number(routingKey >> 56n)

export const BUCKETS = { first: -128, last: 127 } as const

/**
 * Runtime settings a turn needs to write intents: the deployment retry window,
 * which becomes each intent's receipt horizon past its due time, and the
 * relay's wake signal.
 */
export const OutboxRuntime = Context.Reference<{
  readonly retryWindowMs: number
  readonly wake: Effect.Effect<void>
  /** Makes this runner's running attempts check for cancellation now. */
  readonly cancelled: Effect.Effect<void>
}>("durable-actors/OutboxRuntime", {
  defaultValue: () => ({ retryWindowMs: 86_400_000, wake: Effect.void, cancelled: Effect.void }),
})

export const CallerJson = Schema.fromJsonString(Caller)

/** What the relay needs to hear once a turn's outbox writes commit. */
export interface OutboxReplies {
  /** Some row is due now, so the relay should wake. */
  wake: boolean
  /** The turn cancelled an effect attempt that is running. */
  cancelled: boolean
  /** Started effects the turn cancelled; their owner stops showing their progress. */
  cancelledIds: Array<string>
}

/**
 * The statements that write one turn's intents and effects inside its
 * transaction: a delete of committed rows whose keys the turn replaced, the
 * cancellation of committed effects whose keys it cancelled or performed
 * again, then an insert of the staged rows. `now` is the database time due
 * times are measured from; it is read only when there are rows to insert.
 * No statement takes a parameter from another's reply, so they can be sent as
 * one group; `replies` is complete once every statement has replied.
 */
export const outboxStatements = Effect.fnUntraced(function* <R>(
  routingKey: bigint,
  sender: ActorRef,
  outbox: StagedOutbox,
  databaseNow: Effect.Effect<number, SqlError.SqlError, R>,
  commit?: { readonly slackMs: number },
) {
  const sql = yield* SqlClient.SqlClient
  const clock = yield* FrameworkClock
  const { tenant, actor, id } = sender
  const statements: Array<Effect.Effect<void, SqlError.SqlError>> = []
  const replies: OutboxReplies = { wake: false, cancelled: false, cancelledIds: [] }

  const actorRow = sql`routing_key = ${routingKey} AND tenant_id = ${tenant}
    AND actor_type = ${actor} AND actor_id = ${id}`

  // The database clock when the statement runs, on the framework's time line.
  const statementNow = sql`floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + ${clock.offsetMillis()}`

  if (outbox.replaced.length > 0)
    statements.push(
      Effect.asVoid(
        sql`DELETE FROM actor_outbox WHERE ${actorRow} AND timer_key IN ${sql.in(outbox.replaced)}`,
      ),
    )

  if (outbox.cancelledEffects.length > 0) {
    const keys = sql.in(outbox.cancelledEffects.map(effectKey))

    // A never-claimed effect goes. A claim that won the row lock first makes
    // this delete skip it, and the update below, a later statement, then sees
    // it running.
    statements.push(
      Effect.asVoid(sql`DELETE FROM actor_outbox WHERE ${actorRow} AND kind = 'effect'
        AND timer_key IN ${keys} AND attempts = 0 AND NOT running`),
    )

    // A started effect keeps its row as evidence and gives up its key; one not
    // running now is settled by the next claim, a running one by its attempt
    // or, once its lease ends, by any runner.
    statements.push(
      Effect.map(
        sql<{ running: boolean; intent_id: string }>`UPDATE actor_outbox
          SET cancelled_at_ms = stamp.at, timer_key = NULL, waiting = false,
            due_at_ms = CASE WHEN running THEN due_at_ms ELSE least(due_at_ms, stamp.at) END
          FROM (SELECT ${statementNow} AS at) AS stamp
          WHERE ${actorRow} AND kind = 'effect' AND timer_key IN ${keys}
          RETURNING running, intent_id`,
        (marked) => {
          replies.cancelledIds.push(...marked.map((row) => row.intent_id))
          replies.cancelled ||= marked.some((row) => row.running)
          replies.wake ||= marked.some((row) => !row.running)
        },
      ),
    )
  }

  if (outbox.intents.length === 0 && outbox.effects.length === 0) return { statements, replies }

  const crypto = yield* Crypto.Crypto
  const { retryWindowMs } = yield* OutboxRuntime
  const now = yield* databaseNow
  const rows = []

  // The row id is the receiver's command id: an intent's, or an effect's
  // route's. Its expiry keeps that receipt at least one retry window past the
  // due time.
  const rowId = (dueAt: number, slackMs = 0) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => `v1.${now}.${Math.max(dueAt, now) + slackMs + retryWindowMs}.${uuid}`),
    )

  const dueOf = (due: Due | undefined) =>
    due === undefined
      ? now
      : Due.match(due, {
          After: ({ millis }) => now + millis,
          At: ({ epochMillis }) => epochMillis,
        })

  // When `now` was read before the handler ran, a relative delay is moved to
  // the commit statement's clock, and its receipt horizon covers the turn's
  // longest possible run.
  const delayed: Array<string> = []

  const rowIdOf = Effect.fnUntraced(function* (due: Due | undefined, dueAt: number) {
    const relative = commit !== undefined && due?._tag === "After"
    const rowIdentity = yield* rowId(dueAt, relative ? commit.slackMs : 0)

    if (relative) delayed.push(rowIdentity)

    return rowIdentity
  })

  for (const intent of outbox.intents) {
    const dueAt = dueOf(intent.due)

    replies.wake ||= dueAt <= now

    rows.push({
      routing_key: routingKey,
      intent_id: yield* rowIdOf(intent.due, dueAt),
      kind: "intent",
      bucket: bucketOf(routingKey),
      due_at_ms: dueAt,
      scheduled_at_ms: dueAt,
      ready_at_ms: null,
      tenant_id: tenant,
      actor_type: actor,
      actor_id: id,
      timer_key: intent.key ?? null,
      target_type: intent.target.actor,
      target_id: intent.target.id,
      command: intent.command,
      payload: intent.payload,
      caller: yield* Schema.encodeEffect(CallerJson)(intent.caller).pipe(Effect.orDie),
    })
  }

  // An effect row names its effect in `command` and targets its own actor,
  // where its routes deliver; the relay runs its executor when it is due.
  for (const effect of outbox.effects) {
    const dueAt = dueOf(effect.due)

    replies.wake ||= dueAt <= now

    rows.push({
      routing_key: routingKey,
      intent_id: yield* rowIdOf(effect.due, dueAt),
      kind: "effect",
      bucket: bucketOf(routingKey),
      due_at_ms: dueAt,
      scheduled_at_ms: dueAt,
      ready_at_ms: dueAt,
      tenant_id: tenant,
      actor_type: actor,
      actor_id: id,
      timer_key: effect.key === undefined ? null : effectKey(effect.key),
      target_type: actor,
      target_id: id,
      command: effect.effect,
      payload: effect.payload,
      caller: yield* Schema.encodeEffect(CallerJson)(effect.caller).pipe(Effect.orDie),
    })
  }

  statements.push(Effect.asVoid(sql`INSERT INTO actor_outbox ${sql.insert(rows)}`))

  if (delayed.length > 0) {
    const shift = sql`${statementNow} - ${now}`

    statements.push(
      Effect.asVoid(sql`UPDATE actor_outbox
        SET due_at_ms = due_at_ms + ${shift}, scheduled_at_ms = scheduled_at_ms + ${shift},
          ready_at_ms = ready_at_ms + ${shift}
        WHERE routing_key = ${routingKey} AND intent_id IN ${sql.in(delayed)}`),
    )
  }

  return { statements, replies }
})

/**
 * Writes one turn's intents and effects now, reading the database time when it
 * needs it. Returns whether any row is now due, so the caller can wake the
 * relay after commit, and whether it cancelled a running attempt.
 */
export const writeOutbox = Effect.fnUntraced(function* (
  routingKey: bigint,
  sender: ActorRef,
  outbox: StagedOutbox,
) {
  const staged = yield* outboxStatements(routingKey, sender, outbox, databaseTime)

  for (const statement of staged.statements) yield* statement

  return staged.replies
})
