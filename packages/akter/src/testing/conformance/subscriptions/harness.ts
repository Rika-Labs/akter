import { DateTime, Deferred, Effect, Schema } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import { InternalActors } from "../../../runtime/actors.ts"
import { Request, type SubscriptionEnvelope } from "../../../runtime/request.ts"
import { System } from "../../../identity/caller.ts"
import { deliveryCommandId } from "../../../runtime/subscriptions/identity.ts"
import { RetryTurn, type TurnPoint } from "../../../runtime/turn/hooks.ts"
import { ActorTest } from "../../actor-test.ts"
import type { ConformanceEnvironment, ConformanceServices } from "../../conformance.ts"
import { OrderDelivery, OrderPlaced, type SubscriptionsFixture, reset } from "./actors.ts"

export const LogState = Schema.Struct({ log: Schema.optional(Schema.Array(Schema.String)) })

export const logOf = Effect.fnUntraced(function* (actor: string, id: string) {
  const test = yield* ActorTest

  const { state } = yield* test.inspect({ tenant: test.tenant, actor, id })

  return (yield* Schema.decodeUnknownEffect(LogState)(state).pipe(Effect.orDie)).log ?? []
})

export const query = <A>(
  statement: (sql: SqlClient.SqlClient) => Effect.Effect<A, SqlError.SqlError>,
) =>
  Effect.gen(function* () {
    return yield* statement(yield* SqlClient.SqlClient)
  }).pipe(Effect.orDie)

/** The source-side rows of one order in the test tenant, of one subscriber type. */
export const sourceRows = (sourceId: string, subscriberType = "SubFollower") =>
  Effect.gen(function* () {
    const test = yield* ActorTest

    return yield* query(
      (sql) => sql<{
        subscriber_type: string
        subscription: string
        subscriber_id: string
        epoch: string
        active: boolean
        delivered: string
        due: boolean
        attempts: number
        last_error: string | null
      }>`SELECT subscriber_type, subscription, subscriber_id, epoch::text AS epoch, active,
          delivered::text AS delivered, due_at_ms IS NOT NULL AS due, attempts, last_error
        FROM actor_subscriptions WHERE tenant_id = ${test.tenant} AND source_type = 'SubOrder'
          AND source_id = ${sourceId} AND subscriber_type = ${subscriberType}
        ORDER BY subscription, subscriber_id`,
    )
  })

/** The subscriber-side cursor rows of one follower in the test tenant. */
export const cursorRows = (actor: string, id: string) =>
  Effect.gen(function* () {
    const test = yield* ActorTest

    return yield* query(
      (sql) => sql<{
        subscription: string
        source_id: string
        epoch: string
        active: boolean
        applied: string
      }>`SELECT subscription, source_id, epoch::text AS epoch, active, applied::text AS applied
        FROM actor_subscription_cursors WHERE tenant_id = ${test.tenant} AND actor_type = ${actor}
          AND actor_id = ${id}
        ORDER BY subscription, source_id`,
    )
  })

/** Outbox rows of one kind an actor of the test tenant holds. */
export const outboxOf = (actor: string, id: string, kind: "feed" | "control") =>
  Effect.gen(function* () {
    const test = yield* ActorTest

    return (yield* query(
      (sql) => sql<{ count: number }>`SELECT count(*)::int AS count FROM actor_outbox
        WHERE tenant_id = ${test.tenant} AND actor_type = ${actor} AND actor_id = ${id}
          AND kind = ${kind}`,
    ))[0]!.count
  })

/**
 * Tag summary rows that disagree with the active rows carrying each tag. A
 * missed increment loses wakes, and a missed decrement costs feed writes forever.
 */
export const tagMismatches = query(
  (sql) => sql<{ event: string; counted: number | null; summary: number | null }>`
    SELECT event, a.rows AS counted, t.rows AS summary FROM (
      SELECT routing_key, tenant_id, source_type, source_id, x.tag AS event, count(*)::int AS rows
      FROM actor_subscriptions, unnest(events) AS x(tag)
      WHERE active GROUP BY routing_key, tenant_id, source_type, source_id, x.tag
    ) a FULL JOIN actor_subscription_tags t USING (routing_key, tenant_id, source_type, source_id, event)
    WHERE a.rows IS DISTINCT FROM t.rows`,
)

export const drain = ActorTest.use((test) => test.advance(0))

/** Makes the first `point` that `match` accepts die, as a crash there would; later ones pass. */
export const crashOnce = (
  fixture: SubscriptionsFixture,
  point: TurnPoint,
  match: (request: Request) => boolean,
) => {
  const state = { crashed: false }
  fixture.hook = (reached, request) => {
    if (state.crashed || reached !== point || !match(request)) return Effect.void
    state.crashed = true

    return Effect.die(RetryTurn.make({ message: `Injected ${point} crash` }))
  }

  return state
}

/** Holds the first `point` that `match` accepts until `release`. */
export const pauseOnce = Effect.fnUntraced(function* (
  fixture: SubscriptionsFixture,
  point: TurnPoint,
  match: (request: Request) => boolean,
) {
  const reached = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  let paused = false
  fixture.hook = (at, request) => {
    if (paused || at !== point || !match(request)) return Effect.void
    paused = true

    return Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))
  }

  return {
    reached: Deferred.await(reached),
    release: Deferred.succeed(release, undefined).pipe(Effect.asVoid),
  }
})

/** A fault point of one subscription row's work: its tag and its subscriber, or the delivery command. */
export const subscriber = (id: string) => (request: Request) =>
  request.commandId === id || request.ref.id === id

/** A follower's committed log, as entries of one source. */
export const followerLog = (id: string) => logOf("SubFollower", id)

export const handlerRuns = (fixture: SubscriptionsFixture, prefix: string) =>
  fixture.runs.filter((run) => run.startsWith(prefix)).length

const DeliveredOrder = OrderDelivery.members[0]

const encodeDelivery = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(Schema.Struct({ value: OrderDelivery }))),
)

const encodeWithExtra = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.toCodecJson(Schema.Struct({ value: OrderDelivery, extra: Schema.Boolean })),
  ),
)

/** Builds a relay delivery request, as a runner would, for cases that play a stale runner. */
export const deliveryRequest = Effect.fnUntraced(function* (options: {
  readonly subscriber: string
  readonly source: string
  readonly epoch: string
  readonly cursor: string
  /** Re-encodes the delivery with a field a newer schema added. */
  readonly extra?: boolean
  /** The subscriber type, its subscription, its handler, and the source type; `SubFollower`'s `FollowedOrders` of `SubOrder` by default. */
  readonly route?: {
    readonly actor: string
    readonly subscription: string
    readonly command: string
    readonly source: string
  }
}) {
  const test = yield* ActorTest
  const internal = yield* InternalActors

  const route = options.route ?? {
    actor: "SubFollower",
    subscription: "FollowedOrders",
    command: "OnOrder",
    source: "SubOrder",
  }

  const subscriber = { tenant: test.tenant, actor: route.actor, id: options.subscriber }
  const source = { tenant: test.tenant, actor: route.source, id: options.source }

  const envelope: SubscriptionEnvelope = {
    subscription: route.subscription,
    sourceType: route.source,
    sourceId: options.source,
    epoch: options.epoch,
    kind: "event",
    position: options.cursor,
  }

  const [event] = yield* query(
    (sql) => sql<{ emitted_at_ms: string; command_id: string }>`
      SELECT emitted_at_ms::text AS emitted_at_ms, command_id FROM actor_events
      WHERE tenant_id = ${test.tenant} AND actor_type = ${route.source} AND actor_id = ${options.source}
        AND sequence = ${options.cursor}`,
  )

  const value = DeliveredOrder.make({
    subscription: route.subscription,
    source,
    cursor: options.cursor,
    event: OrderPlaced.make({ customerId: "c", amount: 1 }),
    commandId: event!.command_id,
    timestamp: DateTime.makeUnsafe(Number(event!.emitted_at_ms)),
  })

  return Request.make({
    ref: subscriber,
    caller: System.make({ source: "subscription", ref: source }),
    command: route.command,
    commandId: yield* deliveryCommandId({
      subscriber,
      envelope,
      issuedAt: Number(event!.emitted_at_ms),
      retryWindowMs: internal.retryWindowMs,
    }),
    payload:
      options.extra === true
        ? yield* encodeWithExtra({ value, extra: true })
        : yield* encodeDelivery({ value }),
    delivery: envelope,
  })
})

export const run = <A, E>(
  environment: ConformanceEnvironment,
  fixture: SubscriptionsFixture,
  body: Effect.Effect<A, E, ConformanceServices>,
) =>
  environment.run(
    Effect.gen(function* () {
      yield* reset(fixture)
      const result = yield* body
      yield* reset(fixture)

      return result
    }),
  )
