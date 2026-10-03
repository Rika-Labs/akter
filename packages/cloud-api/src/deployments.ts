import { Schema } from "effect"

import {
  CommitSha,
  DeploymentId,
  EnvironmentName,
  NonNegative,
  NonNegativeInt,
  ProjectId,
  RegionId,
  Timestamp,
} from "./primitives.ts"

/**
 * Where a deployment is in its life.
 *
 * A new deployment starts `in-progress` and ends `live` or `failed`. When one
 * becomes `live`, the deployment that was live in the same environment ends
 * `drained` after a normal deploy, or `rolled-back` after a rollback. A failed
 * deployment never replaces the live one.
 */
export const DeploymentStatus = Schema.Literals([
  "in-progress",
  "live",
  "drained",
  "rolled-back",
  "failed",
])
export type DeploymentStatus = typeof DeploymentStatus.Type

export const RolloutStepName = Schema.Literals([
  "build",
  "migrate",
  "start-runners",
  "drain-previous",
])
export type RolloutStepName = typeof RolloutStepName.Type

export const RolloutStep = Schema.Struct({
  name: RolloutStepName,
  status: Schema.Literals(["pending", "running", "succeeded", "failed", "skipped"]),
  durationMs: Schema.NullOr(NonNegativeInt),
  detail: Schema.NullOr(Schema.String),
})
export type RolloutStep = typeof RolloutStep.Type

export const DeploymentRunner = Schema.Struct({
  id: Schema.String,
  region: RegionId,
  actorCount: Schema.NullOr(NonNegativeInt),
  cpuPercent: Schema.NullOr(NonNegative),
  health: Schema.Literals(["healthy", "unhealthy", "starting", "draining"]),
})
export type DeploymentRunner = typeof DeploymentRunner.Type

export const DeploymentAuthor = Schema.Struct({
  name: Schema.String,
  image: Schema.NullOr(Schema.String),
})
export type DeploymentAuthor = typeof DeploymentAuthor.Type

/**
 * `rolledBackFrom` is null unless the deployment was created by a rollback, in
 * which case it is the id of the earlier deployment whose image and
 * environment snapshot it redeploys.
 */
export const DeploymentSummary = Schema.Struct({
  id: DeploymentId,
  projectId: ProjectId,
  environment: EnvironmentName,
  commitSha: CommitSha,
  message: Schema.String,
  author: DeploymentAuthor,
  regions: Schema.Array(RegionId),
  runnerCount: NonNegativeInt,
  durationMs: Schema.NullOr(NonNegativeInt),
  status: DeploymentStatus,
  rolledBackFrom: Schema.NullOr(DeploymentId),
  createdAt: Timestamp,
})
export type DeploymentSummary = typeof DeploymentSummary.Type

export const DeploymentDetail = Schema.Struct({
  ...DeploymentSummary.fields,
  steps: Schema.Array(RolloutStep),
  runners: Schema.Array(DeploymentRunner),
})
export type DeploymentDetail = typeof DeploymentDetail.Type

export const CreateDeployment = Schema.Struct({
  environment: EnvironmentName,
  commitSha: CommitSha,
  message: Schema.optional(Schema.String),
  regions: Schema.optional(Schema.Array(RegionId)),
})
export type CreateDeployment = typeof CreateDeployment.Type

/** A content-addressed image makes a retry and a rollback use the same executable bytes. */
export const ImageDigest = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(?:[^\s@]+@)?sha256:[a-f0-9]{64}$/u)),
)

/** Records a successful external build and starts the durable rollout under the deployment id. */
export const RecordBuild = Schema.Struct({
  image: ImageDigest,
  commitSha: CommitSha,
  environmentSnapshot: Schema.Record(Schema.String, Schema.String).check(
    Schema.makeFilter(
      (snapshot) =>
        Object.keys(snapshot).every((key) => /^[A-Za-z_][A-Za-z0-9_]{0,254}$/u.test(key)) ||
        "Environment variable names must be valid identifiers",
    ),
  ),
})
export type RecordBuild = typeof RecordBuild.Type

export const FailBuild = Schema.Struct({
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
})

export const BuildLogLine = Schema.Struct({
  index: NonNegativeInt,
  at: Timestamp,
  stream: Schema.Literals(["stdout", "stderr"]),
  text: Schema.String,
})
export type BuildLogLine = typeof BuildLogLine.Type

/** Build output from `after` onward; `complete` is true once the build has ended and no later line will appear. */
export const BuildLog = Schema.Struct({
  lines: Schema.Array(BuildLogLine),
  complete: Schema.Boolean,
})
export type BuildLog = typeof BuildLog.Type
