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
 * deployment's declarations (actor types, commands, jobs) or by fixed
 * sets; no metric carries a tenant, actor id, or command id.
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
  activations: Metric.gauge("akter.activations", {
    description: "Activations resident on this runner, by actor_type.",
  }),
  activationsStarted: Metric.counter("akter.activations.started", {
    description:
      "Activations built on this runner, by actor_type, including rebuilds after a defect.",
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
