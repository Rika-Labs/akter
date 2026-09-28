import { Context, Crypto, Effect, Match, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { RegisteredSubscription } from "../../handles/actors.ts"
import {
  Due,
  effectKey,
  type StagedOutbox,
  type StagedSubscription,
} from "../../handles/intents.ts"
import { type ActorRef, Caller, System } from "../../identity/caller.ts"
import { databaseTime } from "./admission.ts"

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
  /**
   * Routed subscriptions registered on this runner whose source is
   * `sourceType`, with their subscriber type; a publishing turn inserts their
   * missing source-side rows.
   */
  readonly routed: (
    sourceType: string,
  ) => ReadonlyArray<RegisteredSubscription & { readonly subscriberType: string }>
}>("durable-actors/OutboxRuntime", {
  defaultValue: () => ({
    retryWindowMs: 86_400_000,
    wake: Effect.void,
    cancelled: Effect.void,
    routed: () => [],
  }),
})

/**
 * A text array parameter, passed as JSON so every driver binds it alike.
 */
export const textArray = ({
  sql,
  values,
}: {
  readonly sql: SqlClient.SqlClient
  readonly values: ReadonlyArray<string>
}) => sql`ARRAY[${sql.csv(values.map((value) => sql`${value}::text`))}]::text[]`

/** A list of strings as JSON text. */
export const StringsJson = Schema.fromJsonString(Schema.Array(Schema.String))

/** The control payload a subscribing turn stages for the relay to register at the source. */
export const ControlPayload = Schema.fromJsonString(
  Schema.Struct({
    op: Schema.Literals(["subscribe", "remove"]),
    epoch: Schema.String,
    /** Where a subscribe starts: `"now"`, `"start"`, or an exclusive cursor. */
    start: Schema.String,
    events: Schema.Array(Schema.String),
  }),
)

/** The outbox key of a subscription's control row: a later change replaces a pending one. */
export const controlKey = (change: Pick<StagedSubscription, "subscription" | "source">) =>
  JSON.stringify(["$sub", change.subscription, change.source.actor, change.source.id])

export const CallerJson = Schema.fromJsonString(Caller)

/**
 * Writes one turn's intents and effects inside its transaction: deletes
 * committed rows whose keys the turn replaced or cancelled, cancels committed
 * effects whose keys it cancelled or performed again, then inserts the staged
 * rows.
 * Returns whether any row is now due, so the caller can wake the relay after
 * commit, and whether it cancelled a running attempt.
 */
export const writeOutbox = Effect.fnUntraced(function* (
  routingKey: bigint,
  sender: ActorRef,
  outbox: StagedOutbox,
) {
  const sql = yield* SqlClient.SqlClient
  const { tenant, actor, id } = sender

  const actorRow = sql`routing_key = ${routingKey} AND tenant_id = ${tenant}
    AND actor_type = ${actor} AND actor_id = ${id}`

  if (outbox.replaced.length > 0)
    yield* sql`DELETE FROM actor_outbox WHERE ${actorRow} AND timer_key IN ${sql.in(outbox.replaced)}`

  let dueNow = false
  let cancelledRunning = false

  if (outbox.cancelledEffects.length > 0) {
    const keys = sql.in(outbox.cancelledEffects.map(effectKey))
    const at = yield* databaseTime

    // A never-claimed effect goes. A claim that won the row lock first makes
    // this delete skip it, and the update below, a later statement, then sees
    // it running.
    yield* sql`DELETE FROM actor_outbox WHERE ${actorRow} AND kind = 'effect'
      AND timer_key IN ${keys} AND attempts = 0 AND NOT running`

    // A started effect keeps its row as evidence and gives up its key; one not
    // running now is settled by the next claim, a running one by its attempt
    // or, once its lease ends, by any runner.
    const marked = yield* sql<{ running: boolean }>`UPDATE actor_outbox
      SET cancelled_at_ms = ${at}, timer_key = NULL, waiting = false,
        due_at_ms = CASE WHEN running THEN due_at_ms ELSE least(due_at_ms, ${at}) END
      WHERE ${actorRow} AND kind = 'effect' AND timer_key IN ${keys}
      RETURNING running`

    cancelledRunning = marked.some((row) => row.running)
    dueNow ||= marked.some((row) => !row.running)
  }

  if (
    outbox.intents.length === 0 &&
    outbox.effects.length === 0 &&
    outbox.subscriptions.length === 0
  )
    return { wake: dueNow, cancelled: cancelledRunning }

  const crypto = yield* Crypto.Crypto
  const { retryWindowMs } = yield* OutboxRuntime
  const now = yield* databaseTime
  dueNow ||= outbox.subscriptions.length > 0
  const rows = []

  // The row id is the receiver's command id: an intent's, or an effect's
  // route's. Its expiry keeps that receipt at least one retry window past the
  // due time.
  const rowId = (dueAt: number) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => `v1.${now}.${Math.max(dueAt, now) + retryWindowMs}.${uuid}`),
    )

  const dueOf = (due: Due | undefined) =>
    due === undefined
      ? now
      : Due.match(due, {
          After: ({ millis }) => now + millis,
          At: ({ epochMillis }) => epochMillis,
        })

  for (const intent of outbox.intents) {
    const dueAt = dueOf(intent.due)

    dueNow ||= dueAt <= now

    rows.push({
      routing_key: routingKey,
      intent_id: yield* rowId(dueAt),
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

    dueNow ||= dueAt <= now

    rows.push({
      routing_key: routingKey,
      intent_id: yield* rowId(dueAt),
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

  if (rows.length > 0) yield* sql`INSERT INTO actor_outbox ${sql.insert(rows)}`

  // Each change moves the subscriber's cursor row to a new epoch, kept
  // forever so the epoch never goes back, and stages the control row that
  // carries that epoch to the source, replacing a pending earlier change.
  const caller = yield* Schema.encodeEffect(CallerJson)(
    System.make({ source: "actor", ref: sender }),
  ).pipe(Effect.orDie)

  for (const change of outbox.subscriptions) {
    const subscribe = change.op === "subscribe"
    // "now" is set by the source when the registration reaches it; "start" is cursor 0.

    const applied = Match.value(change.from).pipe(
      Match.when("now", () => "-1"),
      Match.when("start", () => "0"),
      Match.orElse((cursor) => cursor),
    )

    yield* sql`WITH cursor AS (
        INSERT INTO actor_subscription_cursors (routing_key, tenant_id, actor_type, actor_id,
          subscription, source_type, source_id, epoch, active, applied)
        VALUES (${routingKey}, ${tenant}, ${actor}, ${id}, ${change.subscription},
          ${change.source.actor}, ${change.source.id}, 1, ${subscribe}, ${subscribe ? applied : "-1"})
        ON CONFLICT (routing_key, tenant_id, actor_type, actor_id, subscription, source_type, source_id)
        DO UPDATE SET epoch = actor_subscription_cursors.epoch + 1, active = EXCLUDED.active,
          applied = CASE WHEN EXCLUDED.active THEN EXCLUDED.applied
            ELSE actor_subscription_cursors.applied END
        RETURNING epoch)
      INSERT INTO actor_outbox (routing_key, intent_id, kind, bucket, due_at_ms, scheduled_at_ms,
        tenant_id, actor_type, actor_id, timer_key, target_type, target_id, command, payload, caller)
      SELECT ${routingKey}, ${yield* rowId(now)}, 'control', ${bucketOf(routingKey)}, ${now}, ${now},
        ${tenant}, ${actor}, ${id}, ${controlKey(change)}, ${change.source.actor}, ${change.source.id},
        ${change.subscription},
        json_build_object('op', ${change.op}::text, 'epoch', cursor.epoch::text,
          'start', ${change.from}::text, 'events', to_jsonb(${textArray({ sql, values: change.events })}))::text,
        ${caller}
      FROM cursor
      ON CONFLICT (routing_key, tenant_id, actor_type, actor_id, timer_key) WHERE timer_key IS NOT NULL
      DO UPDATE SET intent_id = EXCLUDED.intent_id, payload = EXCLUDED.payload,
        due_at_ms = EXCLUDED.due_at_ms, scheduled_at_ms = EXCLUDED.scheduled_at_ms,
        attempts = 0, last_error = NULL`
  }

  return { wake: dueNow, cancelled: cancelledRunning }
})
