import { SeriesWindow } from "@akter/cloud-api"
import { Schema as S } from "effect"
import { DeployStatus } from "../deployments/model.ts"
import { CapNotice } from "../quota/model.ts"

/** A headline number on the overview, with the recent trend behind it. */
export const OverviewStat = S.Struct({
  label: S.String,
  value: S.String,
  unit: S.optional(S.String),
  trend: S.Array(S.Finite),
  stepped: S.Boolean,
})

/**
 * One fact in the health summary and whether it needs a look. A fact the runtime does not report
 * reads `—` and is neither healthy nor not, so `healthy` is null.
 */
export const HealthFact = S.Struct({
  label: S.String,
  value: S.String,
  healthy: S.NullOr(S.Boolean),
})

/** A deploy in a short history list; `id` is the deployment id its row links to. */
export const DeploySummary = S.Struct({
  id: S.String,
  commit: S.String,
  message: S.String,
  status: DeployStatus,
  when: S.String,
})
export type DeploySummary = typeof DeploySummary.Type

/**
 * Turn latency over the day: the current median and 99th percentile, and the p99 line, in
 * milliseconds. Each is null when the runtime does not report it.
 */
export const Latency = S.Struct({
  p50: S.NullOr(S.Finite),
  p99: S.NullOr(S.Finite),
  hours: S.Array(S.String),
  p99Series: S.NullOr(S.Array(S.Finite)),
})
export type Latency = typeof Latency.Type

/** One latency bucket: how many turns it took, and whether it is the open-ended tail. */
export const LatencyBar = S.Struct({
  label: S.String,
  count: S.Finite,
  tail: S.Boolean,
})

/**
 * How long turns took over a window, counted per latency bucket. It carries no percentile: buckets
 * from several actor types add up, percentiles do not.
 */
export const LatencyDistribution = S.Struct({
  window: SeriesWindow,
  total: S.Finite,
  bars: S.Array(LatencyBar),
})
export type LatencyDistribution = typeof LatencyDistribution.Type

/**
 * Everything the project overview draws. `throughput` is null when the runtime does not report it,
 * and `previous` is the same window a day earlier, empty when the source has no comparison; a
 * stat's `trend` is empty when it has no history. `distribution` is absent when the actor types'
 * latency buckets cannot be added up, and `distributionSample` marks one that fell back to sample
 * data on an otherwise live page. `deploys` is null when no source reports them, and `cap` absent
 * when the organization has reached no cap that refuses new commands.
 */
export const OverviewPage = S.TaggedStruct("OverviewPage", {
  project: S.String,
  stats: S.Array(OverviewStat),
  hours: S.Array(S.String),
  throughput: S.NullOr(S.Array(S.Finite)),
  previous: S.Array(S.Finite),
  markers: S.Array(S.Struct({ index: S.Finite, label: S.String })),
  health: S.Array(HealthFact),
  latency: Latency,
  distribution: S.optional(LatencyDistribution),
  distributionSample: S.Boolean,
  deploys: S.NullOr(S.Array(DeploySummary)),
  cap: S.optional(CapNotice),
})
export type OverviewPage = typeof OverviewPage.Type

/** A project that has never been deployed. */
export const EmptyProjectPage = S.TaggedStruct("EmptyProjectPage", {
  project: S.String,
  region: S.String,
  cap: S.optional(CapNotice),
})
export type EmptyProjectPage = typeof EmptyProjectPage.Type
