import { Context, Crypto, Effect, Schema } from "effect"
import { SqlClient, type SqlError } from "effect/unstable/sql"
import { Due, type StagedOutbox } from "../../handles/intents.ts"
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
}>("durable-actors/OutboxRuntime", {
  defaultValue: () => ({ retryWindowMs: 86_400_000, wake: Effect.void }),
})

export const CallerJson = Schema.fromJsonString(Caller)

/**
 * The statements that write one turn's intents and effects inside its
 * transaction: a delete of committed rows whose keys the turn replaced or
 * cancelled, then an insert of the staged rows. `now` is the database time
 * due times are measured from; it is read only when there are rows to insert.
 * `dueNow` says whether any inserted row is already due, so the caller can
 * wake the relay after commit.
 */
export const outboxStatements = Effect.fnUntraced(function* <R>(
  routingKey: bigint,
  sender: ActorRef,
  outbox: StagedOutbox,
  databaseNow: Effect.Effect<number, SqlError.SqlError, R>,
  commit?: { readonly slackMs: number },
) {
  const sql = yield* SqlClient.SqlClient
  const { tenant, actor, id } = sender
  const statements: Array<Effect.Effect<void, SqlError.SqlError>> = []

  if (outbox.replaced.length > 0)
    statements.push(
      Effect.asVoid(sql`DELETE FROM actor_outbox WHERE routing_key = ${routingKey} AND tenant_id = ${tenant}
      AND actor_type = ${actor} AND actor_id = ${id} AND timer_key IN ${sql.in(outbox.replaced)}`),
    )

  if (outbox.intents.length === 0 && outbox.effects.length === 0)
    return { statements, dueNow: false }

  const crypto = yield* Crypto.Crypto
  const { retryWindowMs } = yield* OutboxRuntime
  const now = yield* databaseNow
  let dueNow = outbox.effects.length > 0
  const rows = []

  // The row id is the receiver's command id: an intent's, or an effect's
  // route's. Its expiry keeps that receipt at least one retry window past the
  // due time.
  const rowId = (dueAt: number, slackMs = 0) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => `v1.${now}.${Math.max(dueAt, now) + slackMs + retryWindowMs}.${uuid}`),
    )

  // When `now` was read before the handler ran, a relative delay is moved to
  // the commit statement's clock, and its receipt horizon covers the turn's
  // longest possible run.
  const delayed: Array<string> = []

  for (const intent of outbox.intents) {
    const dueAt =
      intent.due === undefined
        ? now
        : Due.match(intent.due, {
            After: ({ millis }) => now + millis,
            At: ({ epochMillis }) => epochMillis,
          })

    dueNow ||= dueAt <= now

    const relative = commit !== undefined && intent.due?._tag === "After"
    const intentId = yield* rowId(dueAt, relative ? commit.slackMs : 0)

    if (relative) delayed.push(intentId)

    rows.push({
      routing_key: routingKey,
      intent_id: intentId,
      kind: "intent",
      bucket: bucketOf(routingKey),
      due_at_ms: dueAt,
      scheduled_at_ms: dueAt,
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
  for (const effect of outbox.effects)
    rows.push({
      routing_key: routingKey,
      intent_id: yield* rowId(now),
      kind: "effect",
      bucket: bucketOf(routingKey),
      due_at_ms: now,
      scheduled_at_ms: now,
      tenant_id: tenant,
      actor_type: actor,
      actor_id: id,
      timer_key: null,
      target_type: actor,
      target_id: id,
      command: effect.effect,
      payload: effect.payload,
      caller: yield* Schema.encodeEffect(CallerJson)(effect.caller).pipe(Effect.orDie),
    })

  statements.push(Effect.asVoid(sql`INSERT INTO actor_outbox ${sql.insert(rows)}`))

  if (delayed.length > 0) {
    const shift = sql`floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + ${(yield* FrameworkClock).offsetMillis() - now}`

    statements.push(
      Effect.asVoid(sql`UPDATE actor_outbox
        SET due_at_ms = due_at_ms + ${shift}, scheduled_at_ms = scheduled_at_ms + ${shift}
        WHERE routing_key = ${routingKey} AND intent_id IN ${sql.in(delayed)}`),
    )
  }

  return { statements, dueNow }
})

/** Writes one turn's intents and effects now, reading the database time when it needs it. */
export const writeOutbox = Effect.fnUntraced(function* (
  routingKey: bigint,
  sender: ActorRef,
  outbox: StagedOutbox,
) {
  const staged = yield* outboxStatements(routingKey, sender, outbox, databaseTime)

  for (const statement of staged.statements) yield* statement

  return staged.dueNow
})
