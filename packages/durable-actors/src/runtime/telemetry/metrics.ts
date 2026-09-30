import { Effect, Metric } from "effect"
import { dual } from "effect/Function"

const milliseconds = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000]

/**
 * Metric names and attribute keys are public, like span names. Prometheus
 * exposition replaces `.` and `-` with `_`, so `durable-actors.turns` is
 * scraped as `durable_actors_turns`. Attributes are bounded by the
 * deployment's declarations (actor types, commands, jobs, subscriptions)
 * or by fixed sets; no metric carries a tenant, actor id, or command id.
 *
 * The database gauges (`outboxRows` and the other sampled series) are read
 * from the database by one runner of the deployment.
 */
export const Metrics = {
  turns: Metric.counter("durable-actors.turns", {
    description:
      "Turns finished on this runner, by actor_type and outcome (success, failure, defect, replay, acknowledged).",
    incremental: true,
  }),
  turnDuration: Metric.histogram("durable-actors.turn.duration_ms", {
    description: "Turn time from the mailbox to the reply, by actor_type.",
    boundaries: milliseconds,
  }),
  mailboxAge: Metric.histogram("durable-actors.mailbox.age_ms", {
    description:
      "How long a command waited between its admission and the start of its turn, by actor_type.",
    boundaries: milliseconds,
  }),
  poolWait: Metric.histogram("durable-actors.pool.wait_ms", {
    description: "How long a turn waited for a session from the turn pool (Postgres only).",
    boundaries: milliseconds,
  }),
  activations: Metric.gauge("durable-actors.activations", {
    description: "Activations resident on this runner, by actor_type.",
  }),
  activationsStarted: Metric.counter("durable-actors.activations.started", {
    description:
      "Activations built on this runner, by actor_type, including rebuilds after a defect.",
    incremental: true,
  }),
  receiptsWritten: Metric.counter("durable-actors.receipts.written", {
    description: "Receipts committed by turns on this runner, by actor_type.",
    incremental: true,
  }),
  receiptsReplayed: Metric.counter("durable-actors.receipts.replayed", {
    description:
      "Commands answered from a stored receipt without running their handler, by actor_type.",
    incremental: true,
  }),
  receiptsPruned: Metric.counter("durable-actors.receipts.pruned", {
    description: "Receipts retention deleted on this runner, by actor_type.",
    incremental: true,
  }),
  eventsAppended: Metric.counter("durable-actors.events.appended", {
    description: "Events committed by turns on this runner, by actor_type.",
    incremental: true,
  }),
  eventsPruned: Metric.counter("durable-actors.events.pruned", {
    description: "Events retention deleted on this runner, by actor_type.",
    incremental: true,
  }),
  outboxStaged: Metric.counter("durable-actors.outbox.staged", {
    description: "Outbox rows committed by turns on this runner, by kind (intent, job).",
    incremental: true,
  }),
  relayDelivered: Metric.counter("durable-actors.relay.delivered", {
    description:
      "Outbox and subscription deliveries this runner settled, by kind (intent, job, subscription).",
    incremental: true,
  }),
  relayRetried: Metric.counter("durable-actors.relay.retried", {
    description: "Deliveries this runner backed off to retry, by kind (intent, job, subscription).",
    incremental: true,
  }),
  deadLetters: Metric.counter("durable-actors.job.dead_letters", {
    description: "Jobs dead-lettered on this runner, by actor_type and job.",
    incremental: true,
  }),
  undeliverableGaps: Metric.counter("durable-actors.subscription.undeliverable_gaps", {
    description:
      "Retention gaps an id-routed subscription row counted without a recipient, by subscriber_type and subscription.",
    incremental: true,
  }),
  outboxRows: Metric.gauge("durable-actors.outbox.rows", {
    description: "Outbox rows waiting, by kind (intent, job, feed, control).",
  }),
  relayLag: Metric.gauge("durable-actors.relay.lag_ms", {
    description:
      "How long the oldest due, unclaimed row has been due, by kind (intent, job, subscription); 0 when none is due.",
  }),
  stuckRows: Metric.gauge("durable-actors.relay.stuck_rows", {
    description: "Rows claimed at least 8 times and still pending, by kind (intent, subscription).",
  }),
  subscriptionLagEvents: Metric.gauge("durable-actors.subscription.lag_events", {
    description:
      "The most source events any row of a subscription is behind, by subscriber_type and subscription.",
  }),
  subscriptionLag: Metric.gauge("durable-actors.subscription.lag_ms", {
    description:
      "The age of the oldest undelivered event of any row of a subscription, by subscriber_type and subscription.",
  }),
  subscriptionPinned: Metric.gauge("durable-actors.subscription.pinned_events", {
    description:
      "Events past keepEvents that subscriptions still hold back from retention, by source actor_type.",
  }),
  workflowPinned: Metric.gauge("durable-actors.workflow.pinned_events", {
    description:
      "Events past keepEvents that open workflow executions still hold back from retention, by actor_type.",
  }),
  fleetLagBytes: Metric.gauge("durable-actors.fleet.lag_bytes", {
    description:
      "WAL bytes between the server's flush position and what the fleet maintainer has applied, by view; on the runner that maintains.",
  }),
  fleetLag: Metric.gauge("durable-actors.fleet.lag_ms", {
    description:
      "Time since the fleet maintainer last drained the change feed, by view; on the runner that maintains.",
  }),
  fleetGroupsRecomputed: Metric.counter("durable-actors.fleet.groups_recomputed", {
    description: "Fleet view groups the maintainer recomputed, by view.",
    incremental: true,
  }),
  fleetBatches: Metric.counter("durable-actors.fleet.batches", {
    description: "Change-feed batches the fleet maintainer applied and advanced past.",
    incremental: true,
  }),
} as const

type Attributes = Readonly<Record<string, string>>

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
  value === 0 ? Effect.void : Metric.update(Metric.withAttributes(metric, attributes), value),
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
  Metric.update(Metric.withAttributes(metric, attributes), value),
)
