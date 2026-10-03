import { Schema as S } from "effect"

/** A headline number on the overview, with the recent trend behind it. */
export const OverviewStat = S.Struct({
  label: S.String,
  value: S.String,
  unit: S.optional(S.String),
  trend: S.Array(S.Finite),
  stepped: S.Boolean,
})

/** One fact in the health summary and whether it needs a look. */
export const HealthFact = S.Struct({
  label: S.String,
  value: S.String,
  healthy: S.Boolean,
})

/** A deploy in a short history list. */
export const DeploySummary = S.Struct({
  commit: S.String,
  message: S.String,
  status: S.Literals(["Live", "Drained", "Rolled back", "Rolling out"]),
  when: S.String,
})
export type DeploySummary = typeof DeploySummary.Type

/** A latency histogram bucket in milliseconds. */
export const LatencyBucket = S.Struct({ upper: S.Finite, count: S.Finite })

/** Everything the project overview draws. */
export const OverviewPage = S.TaggedStruct("OverviewPage", {
  project: S.String,
  stats: S.Array(OverviewStat),
  hours: S.Array(S.String),
  throughput: S.Array(S.Finite),
  previous: S.Array(S.Finite),
  markers: S.Array(S.Struct({ index: S.Finite, label: S.String })),
  health: S.Array(HealthFact),
  latency: S.Array(LatencyBucket),
  deploys: S.Array(DeploySummary),
})
export type OverviewPage = typeof OverviewPage.Type

/** A project that has never been deployed. */
export const EmptyProjectPage = S.TaggedStruct("EmptyProjectPage", {
  project: S.String,
  region: S.String,
})
export type EmptyProjectPage = typeof EmptyProjectPage.Type
