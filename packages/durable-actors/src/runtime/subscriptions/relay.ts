import { DateTime, Effect, Match, Result, Schema } from "effect"
import { SqlError } from "effect/unstable/sql"
import { SubscriptionFailure } from "../../errors/subscription.ts"
import { SqlClient, type Statement } from "effect/unstable/sql"
import type { ActorError } from "../../errors/actor.ts"
import {
  Outcome,
  type RegisteredSubscription,
  Request,
  type SubscriptionEnvelope,
} from "../../handles/actors.ts"
import { ActorRef, System } from "../../identity/caller.ts"
import { decompress, type Placement, routingKey } from "../storage/codec.ts"
import { databaseTime, FrameworkClock } from "../turn/admission.ts"
import { TurnHooks } from "../turn/hooks.ts"
import { ControlPayload, StringsJson, textArray } from "../turn/outbox.ts"
import { candidates, outboxNow } from "../turn/relay.ts"
import { deliveryCommandId } from "./identity.ts"

/** Source-side subscription rows one expansion statement marks at most. */
const EXPANSION_PAGE = 1000

/** A subscription this runner delivers: a subscriber type and one of its declarations. */
export interface LocalSubscription {
  readonly subscriberType: string
  readonly subscription: RegisteredSubscription
}

export interface SubscriptionSettings {
  /** Feed expansions, control registrations, and subscription deliveries each run this many at once. */
  readonly concurrency: number
  /** Matching events one claimed subscription row delivers before it settles. */
  readonly batch: number
  readonly claimLeaseMs: () => number
  readonly maxBackoffMs: number
  readonly retryWindowMs: number
}

interface OutboxWork {
  readonly kind: "feed" | "control"
  readonly routing_key: string
  readonly intent_id: string
  readonly attempts: number
  readonly tenant_id: string
  readonly actor_type: string
  readonly actor_id: string
  readonly target_type: string
  readonly target_id: string
  readonly command: string
  readonly payload: string
  readonly scheduled_at_ms: string
  readonly claimed_until: string
}

interface SubscriptionRow {
  readonly kind: "subscription"
  readonly routing_key: string
  readonly tenant_id: string
  readonly source_type: string
  readonly source_id: string
  readonly subscriber_type: string
  readonly subscription: string
  readonly subscriber_id: string
  readonly events: ReadonlyArray<string>
  readonly epoch: string
  readonly delivered: string
  readonly attempts: number
  readonly claimed_until: string
}

export type SubscriptionWork = OutboxWork | SubscriptionRow

/**
 * CTEs that claim subscription work and the selects that return each claimed
 * item as a JSON `work` column, for the relay's one claim statement.
 */
export interface SubscriptionClaim {
  readonly parts: ReadonlyArray<Statement.Fragment>
  readonly results: ReadonlyArray<Statement.Fragment>
}

/** What the outbox relay runs of a runner's subscription work. */
export interface SubscriptionRelay {
  /** Undefined when this runner registers no subscription or has no free slot. */
  readonly claim: (slots: SubscriptionSlots) => SubscriptionClaim | undefined
  readonly decode: (work: string) => Effect.Effect<SubscriptionWork>
  readonly run: (
    work: SubscriptionWork,
  ) => Effect.Effect<void, SubscriptionError, SqlClient.SqlClient>
  /** Widens a dynamic subscription's rows to the declared event classes, once per startup. */
  readonly widen: (
    subscriberType: string,
    declared: RegisteredSubscription,
  ) => Effect.Effect<void, SubscriptionError, SqlClient.SqlClient>
}

/** How many of each kind of subscription work a runner has room to claim now. */
export interface SubscriptionSlots {
  readonly feed: number
  readonly control: number
  readonly subscription: number
}

const JsonText = Schema.fromJsonString(Schema.Unknown)

/**
 * A delivery as the relay encodes it for any subscriber's handler: the event
 * stays the source's stored JSON, which the handler's own schema decodes.
 */
const WireEvent = Schema.TaggedStruct("Event", {
  subscription: Schema.String,
  source: ActorRef,
  cursor: Schema.String,
  event: Schema.Unknown,
  commandId: Schema.String,
  timestamp: Schema.String,
})

const WireRejected = Schema.TaggedStruct("Rejected", {
  subscription: Schema.String,
  source: ActorRef,
  reason: Schema.Literal("UnknownCursor"),
  cursor: Schema.String,
})

const WireDelivery = Schema.Union([WireEvent, WireRejected])

const encodePayload = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ value: WireDelivery })),
)

const decodeStrings = Schema.decodeEffect(StringsJson)

/** How subscription work can fail; the relay logs it and the row's lease or backoff retries it. */
export type SubscriptionError = SqlError.SqlError | Schema.SchemaError | SubscriptionFailure

const backoff = (attempts: number, settings: SubscriptionSettings) =>
  Math.max(
    settings.claimLeaseMs(),
    Math.min(1000 * 2 ** Math.max(attempts - 1, 0), settings.maxBackoffMs),
  )

/** A request-shaped value naming the work at a fault point, for `TurnHooks`. */
const hookRequest = (ref: ActorRef, command: string, commandId: string) =>
  Request.make({
    ref,
    caller: System.make({ source: "subscription" }),
    command,
    commandId,
    payload: "",
  })

/**
 * The relay's subscription work on one runner: expanding source feeds,
 * registering dynamic subscriptions at their sources, and delivering due
 * subscription rows of the subscriber types this runner registers. A runner
 * that registers none claims none of it.
 */
export const subscriptionRelay = Effect.fnUntraced(function* (options: {
  readonly deliver: (request: Request) => Effect.Effect<Outcome, ActorError>
  readonly local: () => ReadonlyArray<LocalSubscription>
  readonly placementOf: (actorType: string) => Effect.Effect<Placement | undefined>
  readonly wake: Effect.Effect<void>
  readonly settings: SubscriptionSettings
}) {
  const sql = yield* SqlClient.SqlClient
  const hooks = yield* TurnHooks
  const clock = yield* FrameworkClock
  const { settings } = options
  // The outbox clock of the statement it appears in.
  const now = () => outboxNow({ sql, offsetMillis: clock.offsetMillis() })

  const sourceWhere = (alias: string, key: bigint, tenant: string, type: string, id: string) =>
    sql`${sql(alias)}.routing_key = ${key} AND ${sql(alias)}.tenant_id = ${tenant}
      AND ${sql(alias)}.source_type = ${type} AND ${sql(alias)}.source_id = ${id}`

  const eventsOf = (alias: string, key: bigint, tenant: string, type: string, id: string) =>
    sql`${sql(alias)}.routing_key = ${key} AND ${sql(alias)}.tenant_id = ${tenant}
      AND ${sql(alias)}.actor_type = ${type} AND ${sql(alias)}.actor_id = ${id}`

  const outboxClaim = (kind: "feed" | "control", now: Statement.Fragment, limit: number) => {
    const probe = 4 * limit
    const found = sql.literal(`${kind}_candidates`)
    const locked = sql.literal(`${kind}_locked`)
    const claimed = sql.literal(`${kind}_claimed`)

    return sql`${found} AS (
        ${candidates({ sql, kind, now, limit: probe })}
        ORDER BY o.due_at_ms LIMIT ${probe}
      ),
      ${locked} AS (
        SELECT o.routing_key, o.intent_id FROM actor_outbox o
        JOIN ${found} USING (routing_key, intent_id)
        WHERE o.kind = ${kind} AND o.due_at_ms <= ${now}
        ORDER BY o.due_at_ms LIMIT ${limit}
        FOR UPDATE OF o SKIP LOCKED
      ),
      ${claimed} AS (
        UPDATE actor_outbox o SET attempts = o.attempts + 1,
          due_at_ms = ${now} + greatest(${settings.claimLeaseMs()}::bigint,
            least(1000 * power(2, least(o.attempts, 31)), ${settings.maxBackoffMs}::bigint))::bigint
        FROM ${locked} c
        WHERE o.routing_key = c.routing_key AND o.intent_id = c.intent_id
        RETURNING jsonb_build_object('kind', o.kind, 'routing_key', o.routing_key::text,
          'intent_id', o.intent_id, 'attempts', o.attempts, 'tenant_id', o.tenant_id,
          'actor_type', o.actor_type, 'actor_id', o.actor_id, 'target_type', o.target_type,
          'target_id', o.target_id, 'command', o.command, 'payload', o.payload,
          'scheduled_at_ms', coalesce(o.scheduled_at_ms, o.due_at_ms)::text,
          'claimed_until', o.due_at_ms::text)::text AS work
      )`
  }

  /**
   * Claims due feed and control rows and due subscription rows, each up to
   * its free slots, as parts of the relay's claim statement. Subscription
   * rows are probed per bucket and subscriber type through
   * `actor_subscriptions_due`, so caught-up rows and other types' rows are
   * never read, and only rows whose event tags this runner's declaration
   * knows are taken: a runner never settles past a class it can't decode.
   */
  const claim = (slots: SubscriptionSlots): SubscriptionClaim | undefined => {
    const local = options.local()

    if (local.length === 0) return undefined

    const parts: Array<Statement.Fragment> = []
    const results: Array<Statement.Fragment> = []

    for (const kind of ["feed", "control"] as const)
      if (slots[kind] > 0) {
        parts.push(outboxClaim(kind, now(), slots[kind]))
        results.push(sql`SELECT work FROM ${sql.literal(`${kind}_claimed`)}`)
      }

    if (slots.subscription > 0) {
      const probe = 4 * slots.subscription
      const lease = settings.claimLeaseMs()

      parts.push(sql`subscribed (subscriber_type, subscription, known) AS (
            VALUES ${sql.csv(
              local.map(
                ({ subscriberType, subscription }) =>
                  sql`(${subscriberType}::text, ${subscription.tag}::text, ${textArray({
                    sql,
                    values: [...subscription.events, ...subscription.retired],
                  })})`,
              ),
            )}
          ),
          subscription_candidates AS (
            SELECT s.* FROM generate_series(-128, 127) AS b(bucket)
            CROSS JOIN (SELECT DISTINCT subscriber_type FROM subscribed) AS t
            CROSS JOIN LATERAL (
              SELECT routing_key, tenant_id, source_type, source_id, subscriber_type, subscription,
                subscriber_id, due_at_ms
              FROM actor_subscriptions
              WHERE actor_subscriptions.bucket = b.bucket
                AND actor_subscriptions.subscriber_type = t.subscriber_type
                AND actor_subscriptions.due_at_ms <= ${now()}
                AND EXISTS (SELECT 1 FROM subscribed m WHERE m.subscriber_type = actor_subscriptions.subscriber_type
                  AND m.subscription = actor_subscriptions.subscription
                  AND m.known @> actor_subscriptions.events)
              ORDER BY actor_subscriptions.due_at_ms LIMIT ${probe}
            ) s
            ORDER BY s.due_at_ms LIMIT ${probe}
          ),
          subscription_locked AS (
            SELECT s.routing_key, s.tenant_id, s.source_type, s.source_id, s.subscriber_type,
              s.subscription, s.subscriber_id
            FROM actor_subscriptions s
            JOIN subscription_candidates c USING (routing_key, tenant_id, source_type, source_id,
              subscriber_type, subscription, subscriber_id)
            WHERE s.due_at_ms <= ${now()} AND s.active
            ORDER BY s.due_at_ms LIMIT ${slots.subscription}
            FOR UPDATE OF s SKIP LOCKED
          ),
          subscription_claimed AS (
            UPDATE actor_subscriptions s SET attempts = s.attempts + 1,
              due_at_ms = ${now()} + greatest(${lease}::bigint,
                least(1000 * power(2, least(s.attempts, 31)), ${settings.maxBackoffMs}::bigint))::bigint
            FROM subscription_locked c
            WHERE s.routing_key = c.routing_key AND s.tenant_id = c.tenant_id
              AND s.source_type = c.source_type AND s.source_id = c.source_id
              AND s.subscriber_type = c.subscriber_type AND s.subscription = c.subscription
              AND s.subscriber_id = c.subscriber_id
            RETURNING jsonb_build_object('kind', 'subscription', 'routing_key', s.routing_key::text,
              'tenant_id', s.tenant_id, 'source_type', s.source_type, 'source_id', s.source_id,
              'subscriber_type', s.subscriber_type, 'subscription', s.subscription,
              'subscriber_id', s.subscriber_id, 'events', to_jsonb(s.events),
              'epoch', s.epoch::text, 'delivered', s.delivered::text, 'attempts', s.attempts,
              'claimed_until', s.due_at_ms::text)::text AS work
          )`)
      results.push(sql`SELECT work FROM subscription_claimed`)
    }

    return results.length === 0 ? undefined : { parts, results }
  }

  const decode = (work: string) =>
    Schema.decodeEffect(JsonText)(work).pipe(
      Effect.map((row) => row as SubscriptionWork),
      Effect.orDie,
    )

  const placementKey = Effect.fnUntraced(function* (ref: ActorRef) {
    const placement = yield* options.placementOf(ref.actor)

    if (placement === undefined)
      return yield* SubscriptionFailure.make({
        message: `Source type ${ref.actor} has no recorded placement`,
      })

    return routingKey({ ref, placement })
  })

  // Adds each tag of an active row to the source's tag summary.
  const addTags = (key: bigint, source: ActorRef, tags: ReadonlyArray<string>) =>
    tags.length === 0
      ? Effect.void
      : sql`INSERT INTO actor_subscription_tags (routing_key, tenant_id, source_type, source_id, event, rows)
          SELECT ${key}, ${source.tenant}, ${source.actor}, ${source.id}, x.tag, 1
          FROM unnest(${textArray({ sql, values: tags })}) AS x(tag)
          ON CONFLICT (routing_key, tenant_id, source_type, source_id, event)
          DO UPDATE SET rows = actor_subscription_tags.rows + 1`.pipe(Effect.asVoid)

  // Removes one row's tags; each summary row is locked first, so concurrent
  // removals never lose a decrement, and a count reaching 0 is deleted.
  const removeTags = Effect.fnUntraced(function* (
    key: bigint,
    source: ActorRef,
    tags: ReadonlyArray<string>,
  ) {
    for (const tag of tags) {
      const where = sql`routing_key = ${key} AND tenant_id = ${source.tenant}
        AND source_type = ${source.actor} AND source_id = ${source.id} AND event = ${tag}`

      const [row] = yield* sql<{ rows: number }>`SELECT rows FROM actor_subscription_tags
        WHERE ${where} FOR UPDATE`

      if (row === undefined) continue

      if (row.rows <= 1) yield* sql`DELETE FROM actor_subscription_tags WHERE ${where}`
      else yield* sql`UPDATE actor_subscription_tags SET rows = rows - 1 WHERE ${where}`
    }
  })

  /**
   * Deletes a dynamic row the subscriber acknowledged as stale or
   * unsubscribed, but only at the delivery's epoch, so an old acknowledgement
   * never removes a newer subscription.
   */
  const deleteRow = (row: SubscriptionRow, key: bigint, source: ActorRef) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const [gone] = yield* sql<{ active: boolean; events: string }>`
          DELETE FROM actor_subscriptions s
          WHERE ${sourceWhere("s", key, source.tenant, source.actor, source.id)}
            AND s.subscriber_type = ${row.subscriber_type} AND s.subscription = ${row.subscription}
            AND s.subscriber_id = ${row.subscriber_id} AND s.epoch = ${row.epoch}
          RETURNING s.active, to_jsonb(s.events)::text AS events`

        if (gone?.active === true) yield* removeTags(key, source, yield* decodeStrings(gone.events))
      }),
    )

  /**
   * Expands one source's feed: a claimed or backing-off row gets `marked`
   * raised to the source's head, and a caught-up row with a matching event
   * after its `delivered` becomes due. A row already due and unclaimed is left
   * alone, so a burst of commits beside many waiting rows writes nothing. A claimed or backing-off row keeps its due
   * time, so a commit can't cut a retry short, and `marked` alone keeps it
   * due after its settle. The feed row goes only if no commit reset its
   * `attempts` meanwhile; otherwise it stays due and is expanded again.
   */
  const expand = Effect.fnUntraced(function* (row: OutboxWork) {
    const key = BigInt(row.routing_key)
    const source = { tenant: row.tenant_id, actor: row.actor_type, id: row.actor_id }
    yield* hooks.at("afterClaim", hookRequest(source, "$feed", row.intent_id))

    let after: ReadonlyArray<string> = ["", "", ""]

    for (;;) {
      const [page] = yield* sql<{ rows: number; last: string | null }>`
        WITH head AS (
          SELECT event_sequence AS h FROM actor_generations g
          WHERE ${eventsOf("g", key, source.tenant, source.actor, source.id)}),
        page AS (
          SELECT s.subscriber_type, s.subscription, s.subscriber_id FROM actor_subscriptions s
          WHERE ${sourceWhere("s", key, source.tenant, source.actor, source.id)} AND s.active
            AND (s.subscriber_type, s.subscription, s.subscriber_id) > (${after[0]!}, ${after[1]!}, ${after[2]!})
          ORDER BY s.subscriber_type, s.subscription, s.subscriber_id
          LIMIT ${EXPANSION_PAGE}),
        marked AS (
          UPDATE actor_subscriptions s SET marked = greatest(s.marked, head.h),
            due_at_ms = coalesce(s.due_at_ms, ${now()})
          FROM page, head
          WHERE ${sourceWhere("s", key, source.tenant, source.actor, source.id)}
            AND s.subscriber_type = page.subscriber_type AND s.subscription = page.subscription
            AND s.subscriber_id = page.subscriber_id AND s.marked < head.h
            -- A row due and unclaimed since its last settle reads through the
            -- head when it is claimed, so it needs no write.
            AND NOT (s.due_at_ms IS NOT NULL AND s.due_at_ms <= ${now()} AND s.attempts = 0)
            AND (s.due_at_ms IS NOT NULL OR EXISTS (
                SELECT 1 FROM actor_events e
                WHERE ${eventsOf("e", key, source.tenant, source.actor, source.id)}
                  AND e.sequence > s.delivered AND e.sequence <= head.h AND e.event = ANY(s.events)))
          RETURNING 1)
        SELECT (SELECT count(*) FROM page)::int AS rows,
          (SELECT json_build_array(subscriber_type, subscription, subscriber_id)::text FROM page
            ORDER BY subscriber_type DESC, subscription DESC, subscriber_id DESC LIMIT 1) AS last`

      if (page!.rows < EXPANSION_PAGE || page!.last === null) break
      after = yield* decodeStrings(page!.last)
    }

    yield* hooks.at("afterExpand", hookRequest(source, "$feed", row.intent_id))
    yield* sql`DELETE FROM actor_outbox WHERE routing_key = ${key} AND intent_id = ${row.intent_id}
      AND kind = 'feed' AND attempts = ${row.attempts}`
    yield* options.wake
  })

  /** Delivers one subscription delivery and answers how it settled. */
  const deliverOne = Effect.fnUntraced(function* (
    subscriber: ActorRef,
    handler: string,
    source: ActorRef,
    envelope: SubscriptionEnvelope,
    issuedAt: number,
    value: typeof WireDelivery.Type,
  ) {
    const commandId = yield* deliveryCommandId({
      subscriber,
      envelope,
      issuedAt,
      retryWindowMs: settings.retryWindowMs,
    })

    const request = Request.make({
      ref: subscriber,
      caller: System.make({ source: "subscription", ref: source }),
      command: handler,
      commandId,
      payload: yield* encodePayload({ value }),
      delivery: envelope,
    })

    return yield* options.deliver(request).pipe(Effect.result)
  })

  const failure = (outcome: Result.Result<Outcome, ActorError>): string | undefined => {
    if (Result.isFailure(outcome)) return outcome.failure.reason._tag

    if (Outcome.guards.Defect(outcome.success)) return String(outcome.success.cause)

    return undefined
  }

  /**
   * Registers one dynamic subscription change at its source with a framework
   * statement, never a turn, so the source isn't activated. Holding the
   * source's generation row `FOR SHARE` orders it against the emit path's
   * `FOR UPDATE`, and a row changes only for a strictly newer epoch, so a
   * rerun after a crash, or an older change delivered late, changes nothing.
   * A cursor past the source's head is refused: any older row becomes a
   * tombstone at this epoch and the subscriber receives `Rejected`.
   */
  const register = Effect.fnUntraced(function* (row: OutboxWork) {
    const change = yield* Schema.decodeEffect(ControlPayload)(row.payload)
    const subscriber = { tenant: row.tenant_id, actor: row.actor_type, id: row.actor_id }
    const source = { tenant: row.tenant_id, actor: row.target_type, id: row.target_id }
    const epoch = BigInt(change.epoch)
    yield* hooks.at("afterClaim", hookRequest(source, "$control", row.intent_id))
    const key = yield* placementKey(source)
    const pk = sourceWhere("s", key, source.tenant, source.actor, source.id)

    const target = sql`${pk} AND s.subscriber_type = ${subscriber.actor}
      AND s.subscription = ${row.command} AND s.subscriber_id = ${subscriber.id}`

    const rejected = yield* sql.withTransaction(
      Effect.gen(function* () {
        // A source that has never been created can be subscribed to.
        yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
          VALUES (${key}, ${source.tenant}, ${source.actor}, ${source.id}) ON CONFLICT DO NOTHING`

        const [generation] = yield* sql<{ head: string }>`
          SELECT event_sequence::text AS head FROM actor_generations g
          WHERE ${eventsOf("g", key, source.tenant, source.actor, source.id)} FOR SHARE`

        const head = BigInt(generation!.head)

        const [existing] = yield* sql<{
          epoch: string
          active: boolean
          events: string
        }>`SELECT s.epoch::text AS epoch, s.active, to_jsonb(s.events)::text AS events
          FROM actor_subscriptions s
          WHERE ${target} FOR UPDATE`

        const refused =
          change.op === "subscribe" &&
          change.start !== "now" &&
          change.start !== "start" &&
          BigInt(change.start) > head

        if (existing !== undefined && BigInt(existing.epoch) >= epoch)
          // Only a refused subscribe leaves a tombstone at its own epoch.
          return refused && BigInt(existing.epoch) === epoch && !existing.active

        if (existing?.active === true)
          yield* removeTags(key, source, yield* decodeStrings(existing.events))

        if (change.op === "remove" || refused) {
          yield* sql`INSERT INTO actor_subscriptions (routing_key, tenant_id, source_type, source_id,
              subscriber_type, subscription, subscriber_id, events, epoch, active, delivered, bucket)
            VALUES (${key}, ${source.tenant}, ${source.actor}, ${source.id}, ${subscriber.actor},
              ${row.command}, ${subscriber.id}, ${textArray({ sql, values: change.events })}, ${epoch}, false,
              ${head}, ${Number(key >> 56n)})
            ON CONFLICT (routing_key, tenant_id, source_type, source_id, subscriber_type, subscription, subscriber_id)
            DO UPDATE SET epoch = EXCLUDED.epoch, active = false, due_at_ms = NULL, attempts = 0,
              last_error = NULL, gap_at_ms = NULL, gap_through = NULL`

          return refused
        }

        const delivered = Match.value(change.start).pipe(
          Match.when("now", () => head),
          Match.when("start", () => 0n),
          Match.orElse((cursor) => BigInt(cursor)),
        )

        // Due at once when history after the start already matches, so a
        // subscription to a quiet source still delivers it.
        yield* sql`INSERT INTO actor_subscriptions (routing_key, tenant_id, source_type, source_id,
            subscriber_type, subscription, subscriber_id, events, epoch, active, delivered, bucket,
            due_at_ms)
          SELECT ${key}, ${source.tenant}, ${source.actor}, ${source.id}, ${subscriber.actor},
            ${row.command}, ${subscriber.id}, x.events, ${epoch}, true, ${delivered},
            ${Number(key >> 56n)},
            CASE WHEN EXISTS (SELECT 1 FROM actor_events e
                WHERE ${eventsOf("e", key, source.tenant, source.actor, source.id)}
                  AND e.sequence > ${delivered} AND e.sequence <= ${head} AND e.event = ANY(x.events))
              THEN ${now()} END
          FROM (SELECT ${textArray({ sql, values: change.events })} AS events) AS x
          ON CONFLICT (routing_key, tenant_id, source_type, source_id, subscriber_type, subscription, subscriber_id)
          DO UPDATE SET events = EXCLUDED.events, epoch = EXCLUDED.epoch, active = true,
            delivered = EXCLUDED.delivered, marked = 0, due_at_ms = EXCLUDED.due_at_ms, attempts = 0,
            last_error = NULL, gap_at_ms = NULL, gap_through = NULL`

        yield* addTags(key, source, change.events)

        return false
      }),
    )

    const claim = sql`routing_key = ${BigInt(row.routing_key)} AND intent_id = ${row.intent_id}
      AND kind = 'control' AND due_at_ms = ${BigInt(row.claimed_until)}`

    if (rejected) {
      const outcome = yield* deliverOne(
        subscriber,
        yield* handlerOf(subscriber.actor, row.command),
        source,
        {
          subscription: row.command,
          sourceType: source.actor,
          sourceId: source.id,
          epoch: change.epoch,
          kind: "rejected",
          position: change.start,
        },
        Number(row.scheduled_at_ms),
        WireRejected.make({
          subscription: row.command,
          source,
          reason: "UnknownCursor",
          cursor: change.start,
        }),
      )

      const failed = failure(outcome)

      if (failed !== undefined) {
        yield* sql`UPDATE actor_outbox SET last_error = ${failed},
            due_at_ms = ${(yield* databaseTime) + backoff(row.attempts, settings)}
          WHERE ${claim}`

        return
      }
    }

    yield* hooks.at("beforeOutboxDelete", hookRequest(source, "$control", row.intent_id))
    yield* sql`DELETE FROM actor_outbox WHERE ${claim}`
    yield* options.wake
  })

  const handlerOf = Effect.fnUntraced(function* (subscriberType: string, tag: string) {
    const found = options
      .local()
      .find((local) => local.subscriberType === subscriberType && local.subscription.tag === tag)

    if (found === undefined)
      return yield* SubscriptionFailure.make({
        message: `Subscription ${subscriberType}.${tag} is not declared on this runner`,
      })

    return found.subscription.handler
  })

  /**
   * Delivers one claimed subscription row: up to `batch` matching events
   * after `delivered`, one command at a time in cursor order, each waiting
   * for the previous one's outcome, renewing the claim after each. It then
   * settles `delivered` to the position it scanned through, fenced on the
   * claim and the epoch. A failed delivery settles the progress before it and
   * backs the row off; later events wait behind it.
   */
  const deliverRow = Effect.fnUntraced(function* (row: SubscriptionRow, claim: { lease: bigint }) {
    const local = options
      .local()
      .find(
        ({ subscriberType, subscription }) =>
          subscriberType === row.subscriber_type && subscription.tag === row.subscription,
      )

    const source = { tenant: row.tenant_id, actor: row.source_type, id: row.source_id }
    const key = BigInt(row.routing_key)

    const pk = sql`${sourceWhere("s", key, source.tenant, source.actor, source.id)}
      AND s.subscriber_type = ${row.subscriber_type} AND s.subscription = ${row.subscription}
      AND s.subscriber_id = ${row.subscriber_id}`

    const held = () => sql`${pk} AND s.epoch = ${row.epoch} AND s.due_at_ms = ${claim.lease}`

    yield* hooks.at("afterClaim", hookRequest(source, row.subscription, row.subscriber_id))

    const backOff = (progress: bigint, cause: string) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Subscription delivery failed; retrying with backoff").pipe(
          Effect.annotateLogs({
            subscription: `${row.subscriber_type}.${row.subscription}`,
            source: `${source.actor}/${source.id}`,
            tenant: source.tenant,
            cause,
          }),
        )
        yield* sql`UPDATE actor_subscriptions s SET delivered = greatest(s.delivered, ${progress}),
            last_error = ${cause},
            due_at_ms = ${(yield* databaseTime) + backoff(row.attempts, settings)}
          WHERE ${held()}`
      })

    if (local === undefined) return yield* backOff(BigInt(row.delivered), "Undeclared subscription")

    const { subscription } = local

    const batch = yield* sql<{
      head: string
      sequence: string | null
      event: string | null
      command_id: string | null
      value: Uint8Array | null
      emitted_at_ms: string | null
    }>`SELECT (SELECT event_sequence::text FROM actor_generations g
          WHERE ${eventsOf("g", key, source.tenant, source.actor, source.id)}) AS head,
        e.sequence::text AS sequence, e.event, e.command_id, e.value, e.emitted_at_ms::text AS emitted_at_ms
      FROM (VALUES (1)) AS one (x)
      LEFT JOIN LATERAL (
        SELECT sequence, event, command_id, value, emitted_at_ms FROM actor_events e
        WHERE ${eventsOf("e", key, source.tenant, source.actor, source.id)}
          AND e.sequence > ${BigInt(row.delivered)}
          AND e.event = ANY(${textArray({ sql, values: subscription.events })})
        ORDER BY e.sequence LIMIT ${settings.batch}) e ON true`

    const head = BigInt(batch[0]!.head)
    const events = batch.filter((event) => event.sequence !== null)
    let progress = BigInt(row.delivered)

    for (const event of events) {
      const value = decompress(event.value!)

      const subscriberId =
        subscription.routed === undefined
          ? Result.succeed(row.subscriber_id)
          : yield* subscription.route(event.event!, value, source).pipe(Effect.result)

      if (Result.isFailure(subscriberId))
        return yield* backOff(progress, `Route failed: ${String(subscriberId.failure)}`)

      if (subscriberId.success.length === 0)
        return yield* backOff(progress, "Route failed: route returned an empty id")

      const subscriber = {
        tenant: source.tenant,
        actor: row.subscriber_type,
        id: subscriberId.success,
      }

      const outcome = yield* deliverOne(
        subscriber,
        subscription.handler,
        source,
        {
          subscription: row.subscription,
          sourceType: source.actor,
          sourceId: source.id,
          epoch: row.epoch,
          kind: "event",
          position: event.sequence!,
        },
        Number(event.emitted_at_ms),
        WireEvent.make({
          subscription: row.subscription,
          source,
          cursor: event.sequence!,
          event: yield* Schema.decodeEffect(JsonText)(value),
          commandId: event.command_id!,
          timestamp: DateTime.formatIso(DateTime.makeUnsafe(Number(event.emitted_at_ms))),
        }),
      )

      const failed = failure(outcome)

      if (failed !== undefined) return yield* backOff(progress, failed)

      const settled = (outcome as Result.Success<Outcome, ActorError>).success

      if (
        Outcome.guards.Acknowledged(settled) &&
        (settled.reason === "Stale" || settled.reason === "Unsubscribed")
      )
        return yield* deleteRow(row, key, source)

      if (Outcome.guards.Acknowledged(settled) && settled.reason === "NotCreated")
        yield* Effect.logInfo("Subscription event skipped: the subscriber is not created").pipe(
          Effect.annotateLogs({
            subscription: `${row.subscriber_type}.${row.subscription}`,
            subscriber: subscriber.id,
            cursor: event.sequence!,
          }),
        )

      progress = BigInt(event.sequence!)

      // Never shortens the claim, so a renewal can't undo a lease a test clock moved.
      const renewed = yield* sql<{ due_at_ms: string }>`UPDATE actor_subscriptions s
          SET due_at_ms = greatest(s.due_at_ms, ${(yield* databaseTime) + settings.claimLeaseMs()})
          WHERE ${held()} RETURNING s.due_at_ms::text AS due_at_ms`

      if (renewed.length === 0)
        return yield* Effect.logWarning("Subscription delivery lost its claim").pipe(
          Effect.annotateLogs({ subscription: `${row.subscriber_type}.${row.subscription}` }),
        )

      claim.lease = BigInt(renewed[0]!.due_at_ms)
    }

    // A short batch scanned every matching event through the head it read.
    const delivered =
      events.length < settings.batch ? (head > progress ? head : progress) : progress

    yield* hooks.at("beforeSettle", hookRequest(source, row.subscription, row.subscriber_id))

    // Read before the settle, in its own snapshot: a commit after it raised
    // `marked` through its expansion, which the settle reads from the row.
    const [pending] = yield* sql<{ due: boolean }>`SELECT EXISTS (
        SELECT 1 FROM actor_events e
        WHERE ${eventsOf("e", key, source.tenant, source.actor, source.id)}
          AND e.sequence > ${delivered} AND e.event = ANY(${textArray({ sql, values: subscription.events })})
      ) AS due`

    yield* hooks.at("afterSettleSnapshot", hookRequest(source, row.subscription, row.subscriber_id))

    // Widening only ever adds this declaration's classes to the row's list,
    // and each added class enters the tag summary.
    const settle = sql<{ added: string }>`
      WITH old AS (SELECT s.events FROM actor_subscriptions s WHERE ${held()}),
      settled AS (
        UPDATE actor_subscriptions s SET delivered = ${delivered}, attempts = 0, last_error = NULL,
          due_at_ms = CASE WHEN ${pending!.due} OR s.marked > ${delivered} THEN ${now()} END,
          events = CASE WHEN s.events @> ${textArray({ sql, values: subscription.events })} THEN s.events
            ELSE ARRAY(SELECT DISTINCT x FROM unnest(s.events || ${textArray({ sql, values: subscription.events })}) AS u(x) ORDER BY x) END
        WHERE ${held()}
        RETURNING s.events)
      SELECT to_jsonb(ARRAY(SELECT u.x FROM old, unnest(settled.events) AS u(x)
          WHERE NOT u.x = ANY(old.events)))::text AS added
      FROM settled`

    const settled = yield* sql.withTransaction(
      Effect.gen(function* () {
        const [done] = yield* settle

        if (done !== undefined) yield* addTags(key, source, yield* decodeStrings(done.added))

        return done !== undefined
      }),
    )

    if (!settled)
      yield* Effect.logWarning("Subscription settle lost its claim").pipe(
        Effect.annotateLogs({ subscription: `${row.subscriber_type}.${row.subscription}` }),
      )
  })

  // Shutdown releases a claim at once instead of leaving it until its lease
  // ends; the receipt and the cursor make the redelivery safe.
  const release = (work: SubscriptionWork, claim: { lease: bigint }) =>
    Effect.gen(function* () {
      const at = yield* databaseTime

      if (work.kind !== "subscription")
        return yield* sql`UPDATE actor_outbox SET due_at_ms = ${at}
          WHERE routing_key = ${BigInt(work.routing_key)} AND intent_id = ${work.intent_id}
            AND kind = ${work.kind} AND due_at_ms = ${claim.lease}`

      return yield* sql`UPDATE actor_subscriptions SET due_at_ms = ${at}
        WHERE routing_key = ${BigInt(work.routing_key)} AND tenant_id = ${work.tenant_id}
          AND source_type = ${work.source_type} AND source_id = ${work.source_id}
          AND subscriber_type = ${work.subscriber_type} AND subscription = ${work.subscription}
          AND subscriber_id = ${work.subscriber_id} AND epoch = ${work.epoch}
          AND due_at_ms = ${claim.lease}`
    }).pipe(Effect.ignore)

  /**
   * Widens the rows of one dynamic subscription to its declaration's event
   * classes, 1,000 rows per statement, and adds each added class to the tag
   * summary in the same statement. It keeps every cursor and epoch, never
   * narrows a row, and is idempotent, so every runner of a rolling deploy may
   * run it. A widened row with an event of an added class after its
   * `delivered` becomes due. Rows claimed right now are skipped; their settle
   * widens them.
   */
  const widen = Effect.fnUntraced(function* (
    subscriberType: string,
    declared: RegisteredSubscription,
  ) {
    const tags = textArray({ sql, values: declared.events })

    for (;;) {
      const [widened] = yield* sql<{ rows: number }>`
        WITH picked AS (
          SELECT routing_key, tenant_id, source_type, source_id, subscriber_type, subscription,
            subscriber_id, events AS old
          FROM actor_subscriptions
          WHERE subscriber_type = ${subscriberType} AND subscription = ${declared.tag} AND active
            AND NOT events @> ${tags}
          LIMIT ${EXPANSION_PAGE}
          FOR UPDATE SKIP LOCKED),
        widened AS (
          UPDATE actor_subscriptions s
          SET events = ARRAY(SELECT DISTINCT u.x FROM unnest(s.events || ${tags}) AS u(x) ORDER BY u.x),
            due_at_ms = CASE WHEN s.due_at_ms IS NULL AND EXISTS (
                SELECT 1 FROM actor_events e
                WHERE e.routing_key = s.routing_key AND e.tenant_id = s.tenant_id
                  AND e.actor_type = s.source_type AND e.actor_id = s.source_id
                  AND e.sequence > s.delivered AND e.event = ANY(${tags})
                  AND NOT e.event = ANY(p.old))
              THEN ${now()} ELSE s.due_at_ms END
          FROM picked p
          WHERE s.routing_key = p.routing_key AND s.tenant_id = p.tenant_id
            AND s.source_type = p.source_type AND s.source_id = p.source_id
            AND s.subscriber_type = p.subscriber_type AND s.subscription = p.subscription
            AND s.subscriber_id = p.subscriber_id
          RETURNING s.routing_key, s.tenant_id, s.source_type, s.source_id, s.events, p.old),
        summary AS (
          INSERT INTO actor_subscription_tags (routing_key, tenant_id, source_type, source_id, event, rows)
          SELECT w.routing_key, w.tenant_id, w.source_type, w.source_id, x.tag, count(*)::int
          FROM widened w CROSS JOIN LATERAL unnest(w.events) AS x(tag)
          WHERE NOT x.tag = ANY(w.old)
          GROUP BY w.routing_key, w.tenant_id, w.source_type, w.source_id, x.tag
          ON CONFLICT (routing_key, tenant_id, source_type, source_id, event)
          DO UPDATE SET rows = actor_subscription_tags.rows + EXCLUDED.rows
          RETURNING 1)
        SELECT (SELECT count(*) FROM widened)::int AS rows`

      if (widened!.rows < EXPANSION_PAGE) break
    }
  })

  const run = (work: SubscriptionWork) => {
    const claim = { lease: BigInt(work.claimed_until) }

    const running: Effect.Effect<void, SubscriptionError, SqlClient.SqlClient> =
      work.kind === "subscription"
        ? deliverRow(work, claim)
        : Match.value(work.kind).pipe(
            Match.when("feed", () => expand(work)),
            Match.orElse(() => register(work)),
          )

    return running.pipe(Effect.onInterrupt(() => release(work, claim)))
  }

  return { claim, decode, run, widen }
})
