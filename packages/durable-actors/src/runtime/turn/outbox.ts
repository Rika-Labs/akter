import { Context, Crypto, Effect, Match, Schema } from "effect"
import { SqlClient, type SqlError, type Statement } from "effect/unstable/sql"
import type { RegisteredSubscription } from "../../handles/actors.ts"
import {
  Due,
  effectKey,
  type StagedOutbox,
  type StagedSubscription,
} from "../../handles/intents.ts"
import { type ActorRef, Caller, System } from "../../identity/caller.ts"
import { databaseTime, FrameworkClock } from "./admission.ts"

/**
 * The due-work bucket: the top eight bits of `routing_key`. Every runner's
 * relay probes each bucket's `(bucket, kind, due_at_ms)` index range, so actors
 * with nothing due are never read.
 */
export const bucketOf = (routingKey: bigint) => Number(routingKey >> 56n)

/** The inclusive range of values `bucketOf` returns. */
export const BUCKETS = { first: -128, last: 127 } as const

/**
 * Runtime settings a turn needs to write intents: the deployment retry window,
 * which becomes each intent's receipt horizon past its due time, and the
 * relay's wake signal.
 */
export const OutboxRuntime = Context.Reference<{
  readonly retryWindowMs: number
  /** Wakes this runner's relay to claim due rows now instead of at its next poll. */
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

/** A `text[]` expression of `values`, each bound as its own text parameter so every driver binds it alike. */
export const textArray = ({
  sql,
  values,
}: {
  readonly sql: SqlClient.SqlClient
  readonly values: ReadonlyArray<string>
}) => sql`ARRAY[${sql.csv(values.map((value) => sql`${value}::text`))}]::text[]`

/** Codec between a string array and its JSON text. */
export const StringsJson = Schema.fromJsonString(Schema.Array(Schema.String))

/** The payload of a `control` row: the registration change a subscribing turn stages for the relay to apply at the source. */
export const ControlPayload = Schema.fromJsonString(
  Schema.Struct({
    op: Schema.Literals(["subscribe", "remove"]),
    epoch: Schema.String,
    /** Where a subscribe starts: `"now"`, `"start"`, or an exclusive cursor. */
    start: Schema.String,
    events: Schema.Array(Schema.String),
  }),
)

/** The outbox key of a subscription's control row, so a later change replaces a pending one. */
const controlKey = (change: Pick<StagedSubscription, "subscription" | "source">) =>
  JSON.stringify(["$sub", change.subscription, change.source.actor, change.source.id])

/** Codec between a `Caller` and the JSON text stored in an outbox row's `caller` column. */
export const CallerJson = Schema.fromJsonString(Caller)

/** What the relay needs to hear once a turn's outbox writes commit; filled in as the statements reply. */
export interface OutboxReplies {
  /** Some row is due now, so the relay should wake. */
  wake: boolean
  /** The turn cancelled an effect attempt that is running. */
  cancelled: boolean
  /** Started effects the turn cancelled; their owner stops showing their progress. */
  cancelledIds: Array<string>
}

/**
 * The statements that write one turn's intents, effects, and subscription
 * changes inside its transaction, and the effect ids of the new effect rows in
 * `outbox.effects` order. In order they: delete committed rows whose keys the
 * turn replaced; cancel committed effects whose keys it cancelled or performed
 * again; insert the staged rows; upsert each subscription's cursor row and
 * stage its control row; shift delayed rows; order capped effects. No
 * statement takes a parameter from another's reply, so they can be sent as one
 * group; `replies` is complete once every statement has replied.
 *
 * `databaseNow` is the time due times are measured from; it is read only when
 * there are rows to insert. When it was read before the handler ran, `commit`
 * moves each relative delay to the commit statement's clock by one shift, read
 * once because `clock_timestamp()` changes while a statement runs, and its
 * `slackMs` extends the receipt horizon of those rows over the turn's longest
 * possible run.
 *
 * A row's id is the receiver's command id, and its expiry keeps that receipt
 * at least one retry window past the due time. An effect row names its effect
 * in `command` and targets its own actor, where its routes deliver; the relay
 * runs its executor when it is due.
 *
 * A never-claimed cancelled effect is deleted; a claim that won the row lock
 * first makes that delete skip it, and the later update statement then sees it
 * running. A started effect keeps its row as evidence and gives up its key:
 * one not running is settled by the next claim, a running one by its attempt
 * or, once its lease ends, by any runner.
 *
 * Each subscription change moves the subscriber's cursor row to a new epoch,
 * kept forever so the epoch never goes back, and stages the control row that
 * carries that epoch to the source, replacing a pending earlier change for the
 * same subscription and source. A `"now"` start is set by the source when the registration
 * reaches it; `"start"` is cursor 0.
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

  const statementNow = sql`floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + ${clock.offsetMillis()}`

  if (outbox.replaced.length > 0)
    statements.push(
      Effect.asVoid(
        sql`DELETE FROM actor_outbox WHERE ${actorRow} AND timer_key IN ${sql.in(outbox.replaced)}`,
      ),
    )

  if (outbox.cancelledEffects.length > 0) {
    const keys = sql.in(outbox.cancelledEffects.map(effectKey))

    statements.push(
      Effect.asVoid(sql`DELETE FROM actor_outbox WHERE ${actorRow} AND kind = 'effect'
        AND timer_key IN ${keys} AND attempts = 0 AND NOT running`),
    )

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

  if (
    outbox.intents.length === 0 &&
    outbox.effects.length === 0 &&
    outbox.subscriptions.length === 0
  )
    return { statements, replies, effectIds: [] }

  const crypto = yield* Crypto.Crypto
  const { retryWindowMs } = yield* OutboxRuntime
  const now = yield* databaseNow
  replies.wake ||= outbox.subscriptions.length > 0
  const rows = []

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
      payload_version: 0,
      caller: yield* Schema.encodeEffect(CallerJson)(intent.caller).pipe(Effect.orDie),
    })
  }

  const capped: Array<{ readonly id: string; readonly effect: string; readonly dueAt: number }> = []
  const effectIds: Array<string> = []

  for (const effect of outbox.effects) {
    const dueAt = dueOf(effect.due)
    const intentId = yield* rowIdOf(effect.due, dueAt)

    replies.wake ||= dueAt <= now

    if (effect.capped) capped.push({ id: intentId, effect: effect.effect, dueAt })
    effectIds.push(intentId)

    rows.push({
      routing_key: routingKey,
      intent_id: intentId,
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
      payload_version: effect.version,
      caller: yield* Schema.encodeEffect(CallerJson)(effect.caller).pipe(Effect.orDie),
    })
  }

  if (rows.length > 0)
    statements.push(Effect.asVoid(sql`INSERT INTO actor_outbox ${sql.insert(rows)}`))

  const caller = yield* Schema.encodeEffect(CallerJson)(
    System.make({ source: "actor", ref: sender }),
  ).pipe(Effect.orDie)

  for (const change of outbox.subscriptions) {
    const subscribe = change.op === "subscribe"

    const applied = Match.value(change.from).pipe(
      Match.when("now", () => "-1"),
      Match.when("start", () => "0"),
      Match.orElse((cursor) => cursor),
    )

    statements.push(
      Effect.asVoid(sql`WITH cursor AS (
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
          attempts = 0, last_error = NULL`),
    )
  }

  if (delayed.length > 0)
    statements.push(
      Effect.asVoid(sql`UPDATE actor_outbox
        SET due_at_ms = due_at_ms + moved.shift, scheduled_at_ms = scheduled_at_ms + moved.shift,
          ready_at_ms = ready_at_ms + moved.shift
        FROM (SELECT ${statementNow} - ${now} AS shift) AS moved
        WHERE routing_key = ${routingKey} AND intent_id IN ${sql.in(delayed)}`),
    )

  if (capped.length > 0) statements.push(orderCapped({ sql, routingKey, sender, capped }))

  return { statements, replies, effectIds }
})

/**
 * Orders a turn's capped effects behind every earlier effect of their type on
 * this actor that became due no later. Claims take capped rows by
 * `(ready_at_ms, intent_id)`, but the turn's clock has only millisecond
 * resolution and is read before the actor's lock is taken, and effect ids
 * end in a random UUID: effects performed in one turn, or in turns that read
 * the same millisecond, would otherwise run in any order. The actor's lock
 * serializes its turns, so the rows this statement reads are every earlier
 * perform. It runs after any delay shift, so `scheduled_at_ms` is final.
 *
 * Within the turn, an earlier row of one effect type that is due at the same
 * time or no later always ends ahead of the rows after it. The latest
 * `ready_at_ms` of earlier committed rows is probed twice, over rows not
 * running and over running rows, each reading one partial index.
 */
export const orderCapped = ({
  sql,
  routingKey,
  sender,
  capped,
}: {
  readonly sql: SqlClient.SqlClient
  readonly routingKey: bigint
  readonly sender: ActorRef
  readonly capped: ReadonlyArray<{
    readonly id: string
    readonly effect: string
    readonly dueAt: number
  }>
}) => {
  const ranked = capped.map((row, index) => {
    const earlier = capped.slice(0, index).filter(({ effect }) => effect === row.effect)

    return {
      id: row.id,
      tied: earlier.filter(({ dueAt }) => dueAt === row.dueAt).length,
      before: earlier.filter(({ dueAt }) => dueAt <= row.dueAt).length,
    }
  })

  const ids = ranked.map(({ id }) => id)

  const latestOf = (rows: Statement.Fragment) => sql`(SELECT max(e.ready_at_ms)
    FROM actor_outbox e
    WHERE e.routing_key = o.routing_key AND e.tenant_id = o.tenant_id
      AND e.actor_type = o.actor_type AND e.actor_id = o.actor_id AND e.command = o.command
      AND e.kind = 'effect' AND ${rows}
      AND e.scheduled_at_ms <= o.scheduled_at_ms
      AND e.intent_id NOT IN ${sql.in(ids)})`

  const latest = sql`greatest(${latestOf(sql`NOT e.running`)}, ${latestOf(sql`e.running`)})`

  return Effect.asVoid(sql`UPDATE actor_outbox o
    SET ready_at_ms = greatest(o.scheduled_at_ms + v.tied,
      coalesce(${latest}, o.scheduled_at_ms - 1) + 1 + v.before)
    FROM (VALUES ${sql.csv(
      ranked.map(({ id, tied, before }) => sql`(${id}::text, ${tied}::int, ${before}::int)`),
    )}) AS v(intent_id, tied, before)
    WHERE o.routing_key = ${routingKey} AND o.tenant_id = ${sender.tenant}
      AND o.actor_type = ${sender.actor} AND o.actor_id = ${sender.id}
      AND o.intent_id = v.intent_id`)
}

/**
 * Writes one turn's intents and effects now, reading the database time only
 * when there are rows to insert. Returns the `OutboxReplies`, so the caller can
 * wake the relay after commit when a row is due and tell it about cancelled
 * attempts.
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
