import { Schema as S } from "effect"

/** A deploy's outcome, written as a status word. */
export const DeployStatus = S.Literals(["Live", "Drained", "Rolled back", "Rolling out"])
export type DeployStatus = typeof DeployStatus.Type

/** One deploy in the history. */
export const DeployRecord = S.Struct({
  commit: S.String,
  message: S.String,
  author: S.String,
  regions: S.Array(S.String),
  runners: S.Finite,
  took: S.String,
  status: DeployStatus,
  when: S.String,
})
export type DeployRecord = typeof DeployRecord.Type

/** The deployments list. */
export const DeploymentsPage = S.TaggedStruct("DeploymentsPage", {
  deploys: S.Array(DeployRecord),
})
export type DeploymentsPage = typeof DeploymentsPage.Type

/** A phase of the rollout, in seconds from the start of the deploy. */
export const Phase = S.Struct({
  id: S.String,
  label: S.String,
  detail: S.String,
  start: S.Finite,
  end: S.Finite,
})

/** A runner started by the deploy. */
export const Runner = S.Struct({
  id: S.String,
  region: S.String,
  actors: S.Finite,
  cpu: S.String,
  healthy: S.Boolean,
})

/** One deploy in detail: its rollout, its runners and its build log. */
export const DeploymentPage = S.TaggedStruct("DeploymentPage", {
  deploy: DeployRecord,
  phases: S.Array(Phase),
  shift: S.Struct({ start: S.Finite, end: S.Finite, moved: S.Finite }),
  liveAt: S.Finite,
  runners: S.Array(Runner),
  log: S.String,
})
export type DeploymentPage = typeof DeploymentPage.Type
