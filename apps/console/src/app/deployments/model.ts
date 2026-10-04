import { DeploymentRunner, RolloutStep } from "@akter/cloud-api"
import { Schema as S } from "effect"

/** A deploy's outcome, written as a status word. */
export const DeployStatus = S.Literals(["Live", "Drained", "Rolled back", "Rolling out", "Failed"])
export type DeployStatus = typeof DeployStatus.Type

/** One deploy in the history; `id` is the contract's deployment id, which mutations address. */
export const DeployRecord = S.Struct({
  id: S.String,
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
  environment: S.String,
  deploys: S.Array(DeployRecord),
})
export type DeploymentsPage = typeof DeploymentsPage.Type

/** A phase of the rollout, in seconds from the start of the deploy. `status` is the contract's step status. */
export const Phase = S.Struct({
  id: S.String,
  label: S.String,
  detail: S.String,
  start: S.Finite,
  end: S.Finite,
  status: S.optional(RolloutStep.fields.status),
})
export type Phase = typeof Phase.Type

/** A runner started by the deploy; `health` is the contract's runner health. */
export const Runner = S.Struct({
  id: S.String,
  region: S.String,
  actors: S.NullOr(S.Finite),
  cpu: S.String,
  health: DeploymentRunner.fields.health,
})
export type Runner = typeof Runner.Type

/**
 * The earlier deployment a rollback deployment redeployed. `id` is the contract's reference and
 * `commit` is its abbreviated commit, present only when that deployment is in the history the
 * console has read, so an unknown reference shows its id.
 */
export const RolledBackFrom = S.Struct({ id: S.String, commit: S.optional(S.String) })
export type RolledBackFrom = typeof RolledBackFrom.Type

/**
 * What a rollback created: the new deployment, which starts rolling out, and the earlier
 * deployment it redeploys. The console reads the new deployment's commit to navigate to it.
 */
export const RolledBack = S.Struct({
  deploy: DeployRecord,
  rolledBackFrom: S.NullOr(RolledBackFrom),
})
export type RolledBack = typeof RolledBack.Type

/**
 * One deploy in detail: its rollout steps, its runners and its build log. `shift` and `liveAt` draw
 * the rollout timeline and exist only when the source measured them; without them the steps are a
 * table. `rollbackTargets` are the earlier successful deployments of the same environment that a
 * rollback can restore, newest first and empty when the deploy is not live or has none, and
 * `rolledBackFrom` is set when this deploy was created by a rollback. `diffUrl` links the commit
 * when the source knows the repository.
 */
export const DeploymentPage = S.TaggedStruct("DeploymentPage", {
  deploy: DeployRecord,
  phases: S.Array(Phase),
  shift: S.optional(S.Struct({ start: S.Finite, end: S.Finite, moved: S.Finite })),
  liveAt: S.optional(S.Finite),
  runners: S.Array(Runner),
  log: S.String,
  rollbackTargets: S.Array(DeployRecord),
  rolledBackFrom: S.NullOr(RolledBackFrom),
  diffUrl: S.optional(S.String),
})
export type DeploymentPage = typeof DeploymentPage.Type
