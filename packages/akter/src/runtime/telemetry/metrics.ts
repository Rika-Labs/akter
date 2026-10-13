import { Effect, Metric } from "effect"
import { dual } from "effect/Function"

/** The upper bounds, in milliseconds, of every duration histogram's buckets. */
export const milliseconds = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000,
] as const

/**
 * Metric names and attribute keys are public, like span names. Prometheus
 * exposition replaces `.` with `_`. Attributes are bounded by the
 * deployment's declarations (actor types and jobs) or by fixed
 * sets; no metric carries a tenant, actor id, or command id.
 */
export const Metrics = {
  actions: Metric.counter("akter.actions", {
    description: "Durable actions, by actor_type and outcome (success, failure, defect).",
    incremental: true,
  }),
  actionDuration: Metric.histogram("akter.action.duration_ms", {
    description: "Action admission to durability, by actor_type.",
    boundaries: milliseconds,
  }),
  batchEntries: Metric.histogram("akter.batch.entries", {
    description: "Entries per durable segment.",
    boundaries: [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 4096],
  }),
  appendDuration: Metric.histogram("akter.append.duration_ms", {
    description: "Segment append duration.",
    boundaries: milliseconds,
  }),
  appendAmbiguous: Metric.counter("akter.append.ambiguous", { incremental: true }),
  shardOpens: Metric.counter("akter.shard.opens", { incremental: true }),
  replayEntries: Metric.histogram("akter.replay.entries", {
    boundaries: [0, 1, 10, 100, 1000, 10_000, 100_000],
  }),
  pageMisses: Metric.counter("akter.page.misses", { incremental: true }),
  activations: Metric.gauge("akter.activations", {
    description: "Activations resident on this runner, by actor_type.",
  }),
  jobs: Metric.counter("akter.jobs", { incremental: true }),
  admissionRefused: Metric.counter("akter.admission.refused", { incremental: true }),
  gcDeleted: Metric.counter("akter.gc.deleted", { incremental: true }),
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
