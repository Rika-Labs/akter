import { Effect, Metric } from "effect"
import { dual } from "effect/Function"

/** The upper bounds, in milliseconds, of every duration histogram's buckets. */
export const milliseconds = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000,
] as const

/**
 * Metric names and attribute keys are public, like span names. Prometheus
 * exposition replaces `.` and `-` with `_`, so `akter.turns` is
 * scraped as `akter_turns`. Attributes are bounded by the
 * deployment's declarations (actor types, commands, jobs, subscriptions)
 * or by fixed sets; no metric carries a tenant, actor id, or command id.
 *
 * The database gauges (`outboxRows` and the other sampled series) are read
 * from the database by one runner of the deployment.
 */
export const Metrics = {
  turns: Metric.counter("akter.turns", {
    description:
      "Turns finished on this runner, by actor_type and outcome (success, failure, defect, replay, acknowledged).",
    incremental: true,
  }),
  turnDuration: Metric.histogram("akter.turn.duration_ms", {
    description: "Turn time from the mailbox to the reply, by actor_type.",
    boundaries: milliseconds,
  }),
  mailboxAge: Metric.histogram("akter.mailbox.age_ms", {
    description:
      "How long a command waited between its admission and the start of its turn, by actor_type.",
    boundaries: milliseconds,
  }),
  poolWait: Metric.histogram("akter.pool.wait_ms", {
    description: "How long a turn waited for a session from the turn pool (Postgres only).",
    boundaries: milliseconds,
  }),
  activations: Metric.gauge("akter.activations", {
    description: "Activations resident on this runner, by actor_type.",
  }),
  activationsStarted: Metric.counter("akter.activations.started", {
    description:
      "Activations built on this runner, by actor_type, including rebuilds after a defect.",
    incremental: true,
  }),
  receiptsWritten: Metric.counter("akter.receipts.written", {
    description: "Receipts committed by turns on this runner, by actor_type.",
    incremental: true,
  }),
  receiptsReplayed: Metric.counter("akter.receipts.replayed", {
    description:
      "Commands answered from a stored receipt without running their handler, by actor_type.",
    incremental: true,
  }),
  receiptsPruned: Metric.counter("akter.receipts.pruned", {
    description: "Receipts retention deleted on this runner, by actor_type.",
    incremental: true,
  }),
  eventsAppended: Metric.counter("akter.events.appended", {
    description: "Events committed by turns on this runner, by actor_type.",
    incremental: true,
  }),
  eventsPruned: Metric.counter("akter.events.pruned", {
    description: "Events retention deleted on this runner, by actor_type.",
    incremental: true,
  }),
  outboxStaged: Metric.counter("akter.outbox.staged", {
    description: "Outbox rows committed by turns on this runner, by kind (intent, job).",
    incremental: true,
  }),
  relayDelivered: Metric.counter("akter.relay.delivered", {
    description:
      "Outbox and subscription deliveries this runner settled, by kind (intent, job, subscription).",
    incremental: true,
  }),
  relayRetried: Metric.counter("akter.relay.retried", {
    description: "Deliveries this runner backed off to retry, by kind (intent, job, subscription).",
    incremental: true,
  }),
  deadLetters: Metric.counter("akter.job.dead_letters", {
    description: "Jobs dead-lettered on this runner, by actor_type and job.",
    incremental: true,
  }),
  undeliverableGaps: Metric.counter("akter.subscription.undeliverable_gaps", {
    description:
      "Retention gaps an id-routed subscription row counted without a recipient, by subscriber_type and subscription.",
    incremental: true,
  }),
  outboxRows: Metric.gauge("akter.outbox.rows", {
    description: "Outbox rows waiting, by kind (intent, job, feed, control).",
  }),
  relayLag: Metric.gauge("akter.relay.lag_ms", {
    description:
      "How long the oldest due, unclaimed row has been due, by kind (intent, job, subscription); 0 when none is due.",
  }),
  stuckRows: Metric.gauge("akter.relay.stuck_rows", {
    description: "Rows claimed at least 8 times and still pending, by kind (intent, subscription).",
  }),
  subscriptionLagEvents: Metric.gauge("akter.subscription.lag_events", {
    description:
      "The most source events any row of a subscription is behind, by subscriber_type and subscription.",
  }),
  subscriptionLag: Metric.gauge("akter.subscription.lag_ms", {
    description:
      "The age of the oldest undelivered event of any row of a subscription, by subscriber_type and subscription.",
  }),
  subscriptionPinned: Metric.gauge("akter.subscription.pinned_events", {
    description:
      "Events past keepEvents that subscriptions still hold back from retention, by source actor_type.",
  }),
  workflowPinned: Metric.gauge("akter.workflow.pinned_events", {
    description:
      "Events past keepEvents that open workflow executions still hold back from retention, by actor_type.",
  }),
  fleetLagBytes: Metric.gauge("akter.fleet.lag_bytes", {
    description:
      "WAL bytes between the server's flush position and what the fleet maintainer has applied, by view; on the runner that maintains.",
  }),
  fleetLag: Metric.gauge("akter.fleet.lag_ms", {
    description:
      "Time since the fleet maintainer last drained the change feed, by view; on the runner that maintains.",
  }),
  fleetGroupsRecomputed: Metric.counter("akter.fleet.groups_recomputed", {
    description: "Fleet view groups the maintainer recomputed, by view.",
    incremental: true,
  }),
  fleetBatches: Metric.counter("akter.fleet.batches", {
    description: "Change-feed batches the fleet maintainer applied and advanced past.",
    incremental: true,
  }),
} as const

type Attributes = Readonly<Record<string, string>>

const attributedMetrics = new WeakMap<
  Metric.Metric<number, unknown>,
  Map<string, Metric.Metric<number, unknown>>
>()

/**
 * The metric under `attributes`, made once per attribute set and reused. A
 * fresh `Metric.withAttributes` re-derives its series key, sorting and
 * serializing the attributes, on every update. Attribute sets are bounded by
 * the deployment's declarations, so the cache is too.
 */
const attributed = (metric: Metric.Metric<number, unknown>, attributes: Attributes) => {
  let byKey = attributedMetrics.get(metric)

  if (byKey === undefined) {
    byKey = new Map()
    attributedMetrics.set(metric, byKey)
  }

  const key = JSON.stringify(
    Object.entries(attributes).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  )

  let cached = byKey.get(key)

  if (cached === undefined) {
    cached = Metric.withAttributes(metric, attributes)
    byKey.set(key, cached)
  }

  return cached
}

/** Adds `value` to `metric` under `attributes`; a zero adds nothing. Never fails. */
export const count: {
  (
    attributes: Attributes,
    value: number,
  ): (metric: Metric.Metric<number, unknown>) => Effect.Effect<void>
  (
    metric: Metric.Metric<number, unknown>,
    attributes: Attributes,
    value: number,
  ): Effect.Effect<void>
} = dual(3, (metric: Metric.Metric<number, unknown>, attributes: Attributes, value: number) =>
  value === 0 ? Effect.void : Metric.update(attributed(metric, attributes), value),
)

/** Sets a gauge, or records a histogram observation, under `attributes`. */
export const record: {
  (
    attributes: Attributes,
    value: number,
  ): (metric: Metric.Metric<number, unknown>) => Effect.Effect<void>
  (
    metric: Metric.Metric<number, unknown>,
    attributes: Attributes,
    value: number,
  ): Effect.Effect<void>
} = dual(3, (metric: Metric.Metric<number, unknown>, attributes: Attributes, value: number) =>
  Metric.update(attributed(metric, attributes), value),
)
