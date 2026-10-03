import { Schema as S } from "effect"

/** A running or finished workflow owned by an actor. */
export const WorkflowRun = S.Struct({
  id: S.String,
  workflow: S.String,
  actorType: S.String,
  key: S.String,
  step: S.String,
  waitingFor: S.String,
  started: S.String,
  status: S.Literals(["Waiting", "Running", "Sleeping", "Done"]),
})

/** A cron schedule that sends a command to an actor or a set of actors. */
export const Schedule = S.Struct({
  name: S.String,
  target: S.String,
  cron: S.String,
  lastRun: S.String,
  nextRun: S.String,
})

/** The workflows and timers page. */
export const WorkflowsPage = S.TaggedStruct("WorkflowsPage", {
  running: S.Finite,
  waitingOnEvents: S.Finite,
  timers: S.Finite,
  nextTimer: S.String,
  runs: S.Array(WorkflowRun),
  schedules: S.Array(Schedule),
  hours: S.Array(S.String),
  timersFired: S.Array(S.Finite),
})
export type WorkflowsPage = typeof WorkflowsPage.Type
