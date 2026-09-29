import { Context, Effect, type Metric } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { databaseTime } from "../turn/admission.ts"
import { Metrics, record } from "./metrics.ts"

/** Claims at or above this count mark a row as stuck, for intents and subscriptions alike. */
export const STUCK_ATTEMPTS = 8

export interface SampledType {
  readonly actorType: string
  readonly keepEventsMs: number
  readonly holdEventsMs: number
}

/**
 * Reports the gauges only the database knows. Each statement reads pending
 * work or retained history past its horizon, never every stored actor: the
 * outbox and due subscription rows are the relay's backlog, and events past
 * `keepEvents` stay only while something pins them. A series that stops
 * appearing is reported as 0 once, so a recovered subscription or an emptied
 * kind does not keep its last value.
 */
export const databaseSampler = () => {
  const reported = new Map<
    string,
    { metric: Metric.Metric<number, unknown>; attributes: Record<string, string> }
  >()

  return Effect.fnUntraced(function* (types: ReadonlyArray<SampledType>) {
    const sql = yield* SqlClient.SqlClient
    const now = yield* databaseTime

    const values = new Map<
      string,
      { metric: Metric.Metric<number, unknown>; attributes: Record<string, string>; value: number }
    >()

    const set = (
      metric: Metric.Metric<number, unknown>,
      attributes: Record<string, string>,
      value: number,
    ) => {
      values.set(`${metric.id}${JSON.stringify(attributes)}`, { metric, attributes, value })
    }

    const outbox = yield* sql<{ kind: string; rows: number; lag: string; stuck: number }>`
      SELECT kind, count(*)::int AS rows,
        COALESCE(max(${now}::bigint - due_at_ms) FILTER (WHERE due_at_ms <= ${now}), 0)::text AS lag,
        count(*) FILTER (WHERE attempts >= ${STUCK_ATTEMPTS})::int AS stuck
      FROM actor_outbox GROUP BY kind`

    for (const kind of ["intent", "effect", "feed", "control"]) {
      const row = outbox.find((found) => found.kind === kind)

      set(Metrics.outboxRows, { kind }, row?.rows ?? 0)
      set(Metrics.relayLag, { kind }, Number(row?.lag ?? 0))
    }

    set(
      Metrics.stuckRows,
      { kind: "intent" },
      outbox.find((row) => row.kind === "intent")?.stuck ?? 0,
    )

    // Only due or backing-off rows have undelivered events; the partial due index covers them.
    const subscriptions = yield* sql<{
      subscriber_type: string
      subscription: string
      events: string
      lag: string
      due: string
      stuck: number
    }>`
      SELECT s.subscriber_type, s.subscription,
        max(g.event_sequence - s.delivered)::text AS events,
        COALESCE(max(${now}::bigint - e.emitted_at_ms), 0)::text AS lag,
        COALESCE(max(${now}::bigint - s.due_at_ms) FILTER (WHERE s.due_at_ms <= ${now}), 0)::text AS due,
        count(*) FILTER (WHERE s.attempts >= ${STUCK_ATTEMPTS})::int AS stuck
      FROM actor_subscriptions s
      JOIN actor_generations g ON g.routing_key = s.routing_key AND g.tenant_id = s.tenant_id
        AND g.actor_type = s.source_type AND g.actor_id = s.source_id
      LEFT JOIN LATERAL (
        SELECT e.emitted_at_ms FROM actor_events e
        WHERE e.routing_key = s.routing_key AND e.tenant_id = s.tenant_id
          AND e.actor_type = s.source_type AND e.actor_id = s.source_id
          AND e.sequence > s.delivered AND e.event = ANY(s.events)
        ORDER BY e.sequence LIMIT 1) e ON true
      WHERE s.active AND s.due_at_ms IS NOT NULL
      GROUP BY s.subscriber_type, s.subscription`

    let subscriptionLag = 0
    let subscriptionStuck = 0

    for (const row of subscriptions) {
      const attributes = { subscriber_type: row.subscriber_type, subscription: row.subscription }

      set(Metrics.subscriptionLagEvents, attributes, Number(row.events))
      set(Metrics.subscriptionLag, attributes, Number(row.lag))
      subscriptionLag = Math.max(subscriptionLag, Number(row.due))
      subscriptionStuck += row.stuck
    }

    set(Metrics.relayLag, { kind: "subscription" }, subscriptionLag)
    set(Metrics.stuckRows, { kind: "subscription" }, subscriptionStuck)

    // Events past keepEvents stay only while a hold pins them, so this reads the pinned rows alone.
    for (const type of types) {
      const cutoff = now - type.keepEventsMs
      const holdCutoff = cutoff - type.holdEventsMs

      const [pinned] = yield* sql<{ subscriptions: number; workflows: number }>`
        SELECT
          count(*) FILTER (WHERE e.emitted_at_ms > ${holdCutoff} AND e.sequence > s.held)::int AS subscriptions,
          count(*) FILTER (WHERE e.sequence > w.held)::int AS workflows
        FROM actor_events e
        LEFT JOIN LATERAL (
          SELECT min(s.delivered) AS held FROM actor_subscriptions s
          WHERE s.routing_key = e.routing_key AND s.tenant_id = e.tenant_id
            AND s.source_type = e.actor_type AND s.source_id = e.actor_id AND s.active) s ON true
        LEFT JOIN LATERAL (
          SELECT min(LEAST(x.event_cursor, COALESCE(w.wait_after, x.event_cursor))) AS held
          FROM actor_workflow_executions x
          LEFT JOIN actor_workflow_step w ON w.routing_key = x.routing_key
            AND w.execution_id = x.execution_id AND w.kind = 'wait' AND w.exit IS NULL
          WHERE x.routing_key = e.routing_key AND x.tenant_id = e.tenant_id
            AND x.actor_type = e.actor_type AND x.actor_id = e.actor_id
            AND x.status <> 'finished') w ON true
        WHERE e.actor_type = ${type.actorType} AND e.emitted_at_ms <= ${cutoff}`

      set(Metrics.subscriptionPinned, { actor_type: type.actorType }, pinned?.subscriptions ?? 0)
      set(Metrics.workflowPinned, { actor_type: type.actorType }, pinned?.workflows ?? 0)
    }

    for (const [key, series] of reported)
      if (!values.has(key)) yield* record(series.metric, series.attributes, 0)

    reported.clear()

    for (const [key, { metric, attributes, value }] of values) {
      yield* record(metric, attributes, value)
      reported.set(key, { metric, attributes })
    }
  })
}

/** Samples the database gauges at once; the runtime also samples every `observability.sampleEvery`. */
export class TelemetrySampler extends Context.Service<
  TelemetrySampler,
  { readonly sample: Effect.Effect<void> }
>()("@durable-actors/core/runtime/telemetry/sampler/TelemetrySampler") {}
