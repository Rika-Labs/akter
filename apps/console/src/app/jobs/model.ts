import { Schema as S } from "effect"

/**
 * A job that ran out of retries and waits for a person to retry or discard it. `id` is the dead
 * letter's own id, which retry and discard address; `jobId` is the job that died.
 */
export const DeadLetter = S.Struct({
  id: S.String,
  jobId: S.String,
  job: S.String,
  actorType: S.String,
  key: S.String,
  attempts: S.Finite,
  error: S.String,
  since: S.String,
})
export type DeadLetter = typeof DeadLetter.Type

/** Today's totals for one job type; jobs done is null and p99 reads `—` when unreported. */
export const JobTypeTotals = S.Struct({
  name: S.String,
  done: S.NullOr(S.Finite),
  retried: S.Finite,
  dead: S.Finite,
  p99: S.String,
})

/**
 * The jobs page: queue totals, dead letters, totals by type and recent throughput, one label per
 * point. `running` and `throughput` are null when the runtime does not report them. `resolvable` is
 * whether the source can retry and discard dead letters at all; when it cannot, the page offers
 * neither and says so once.
 */
export const JobsPage = S.TaggedStruct("JobsPage", {
  queued: S.Finite,
  running: S.NullOr(S.Finite),
  retrying: S.Finite,
  deadLetters: S.Array(DeadLetter),
  resolvable: S.Boolean,
  types: S.Array(JobTypeTotals),
  labels: S.Array(S.String),
  throughput: S.NullOr(S.Array(S.Finite)),
})
export type JobsPage = typeof JobsPage.Type
