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
  actorCount: NonNegativeInt,
  cpuPercent: NonNegative,
  health: Schema.Literals(["healthy", "unhealthy", "starting", "draining"]),
})
export type DeploymentRunner = typeof DeploymentRunner.Type

export const DeploymentAuthor = Schema.Struct({
  name: Schema.String,
  image: Schema.NullOr(Schema.String),
})
export type DeploymentAuthor = typeof DeploymentAuthor.Type

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
