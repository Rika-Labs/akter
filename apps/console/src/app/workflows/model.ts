import { Schema as S } from "effect"

/**
 * A running or finished workflow owned by an actor. A workflow waiting on a timer reads `Sleeping`,
 * and `status` is null when the run's stored result does not decode.
 */
export const WorkflowRun = S.Struct({
  id: S.String,
  workflow: S.String,
  actorType: S.String,
  key: S.String,
  step: S.String,
  waitingFor: S.String,
  started: S.String,
  status: S.NullOr(S.Literals(["Waiting", "Running", "Sleeping", "Done", "Failed"])),
})
export type WorkflowRun = typeof WorkflowRun.Type

/** A cron schedule that sends a command to an actor or a set of actors. */
export const Schedule = S.Struct({
  name: S.String,
  target: S.String,
  cron: S.String,
  lastRun: S.String,
  nextRun: S.String,
})
export type Schedule = typeof Schedule.Type

/** How many timers a day fired, per half hour. */
export const TimersFired = S.Struct({ hours: S.Array(S.String), values: S.Array(S.Finite) })

/**
 * The workflows and timers page. The run counts are taken over `runs`; `truncated` is true when
 * the source holds more runs than the page lists, so the counts are lower bounds. `nextTimer` and
 * `nextSchedule` are `null` when nothing is pending, and `fired` is drawn when the source reports
 * timer history. `schedulesSample` marks schedules that fell back to sample data on an otherwise
 * live page.
 */
export const WorkflowsPage = S.TaggedStruct("WorkflowsPage", {
  running: S.Finite,
  waitingOnEvents: S.Finite,
  truncated: S.Boolean,
  timers: S.Finite,
  nextTimer: S.NullOr(S.String),
  nextSchedule: S.NullOr(S.String),
  runs: S.Array(WorkflowRun),
  schedules: S.Array(Schedule),
  schedulesSample: S.Boolean,
  fired: S.optional(TimersFired),
})
export type WorkflowsPage = typeof WorkflowsPage.Type
