import type {
  BuildLog,
  DeploymentDetail,
  DeploymentStatus,
  DeploymentSummary,
  EnvironmentName,
  RolloutStepName,
} from "@akter/cloud-api"
import { formatDuration } from "@akter/ui/geometry"
import { DateTime } from "effect"
import { ago } from "../overview/time.ts"
import {
  type DeployRecord,
  DeploymentPage,
  DeploymentsPage,
  type DeployStatus,
  type Phase,
  type RolledBack,
  type RolledBackFrom,
} from "./model.ts"

const statuses: Readonly<Record<DeploymentStatus, DeployStatus>> = {
  "in-progress": "Rolling out",
  live: "Live",
  drained: "Drained",
  "rolled-back": "Rolled back",
  failed: "Failed",
}

const stepLabels: Readonly<Record<RolloutStepName, string>> = {
  build: "Build",
  migrate: "Migrate",
  "start-runners": "Start runners",
  "drain-previous": "Drain previous",
}

/** The abbreviated commit the console shows and routes by. */
export const shortCommit = (commitSha: string): string => commitSha.slice(0, 7)

/** The status word for a contract deployment status. */
export const deployStatusOf = (status: DeploymentStatus): DeployStatus => statuses[status]

/** One deployment as a history row. A deployment that has not finished has no duration, written `—`. */
export const toDeployRecord =
  (now: DateTime.Utc) =>
  (summary: DeploymentSummary): DeployRecord => ({
    id: summary.id,
    commit: shortCommit(summary.commitSha),
    message: summary.message,
    author: summary.author.name,
    regions: summary.regions,
    runners: summary.runnerCount,
    took: summary.durationMs === null ? "—" : formatDuration(summary.durationMs),
    status: statuses[summary.status],
    when: ago(now)(summary.createdAt),
  })

const newestFirst = (left: DeploymentSummary, right: DeploymentSummary): number =>
  DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt)

/** The deploy history, newest first. */
export const toDeploymentsPage =
  (now: DateTime.Utc) =>
  (
    input: Readonly<{
      environment: EnvironmentName
      summaries: ReadonlyArray<DeploymentSummary>
    }>,
  ): DeploymentsPage =>
    DeploymentsPage.make({
      environment: input.environment,
      deploys: [...input.summaries].sort(newestFirst).map(toDeployRecord(now)),
    })

/** Lays the rollout steps end to end in seconds from the start of the deploy; an unfinished step has no width. */
export const toPhases = (steps: DeploymentDetail["steps"]): ReadonlyArray<Phase> => {
  let elapsed = 0
  return steps.map((step) => {
    const start = elapsed
    elapsed += (step.durationMs ?? 0) / 1000
    return {
      id: step.name,
      label: stepLabels[step.name],
      detail: step.detail ?? "",
      start,
      end: elapsed,
      status: step.status,
    }
  })
}

const restorable: ReadonlySet<DeploymentStatus> = new Set(["live", "drained", "rolled-back"])

/**
 * The deployments a rollback from `current` can restore, newest first. A rollback is offered only
 * from the live deployment, and may restore any earlier deployment of its environment that reached
 * `live` (status `live`, `drained` or `rolled-back`); a failed or still rolling deployment, a
 * deployment of another environment, `current` itself and anything created after it never qualify.
 */
export const rollbackCandidates =
  (current: DeploymentSummary) =>
  (history: ReadonlyArray<DeploymentSummary>): ReadonlyArray<DeploymentSummary> =>
    current.status !== "live"
      ? []
      : history
          .filter(
            (candidate) =>
              candidate.id !== current.id &&
              candidate.environment === current.environment &&
              restorable.has(candidate.status) &&
              DateTime.toEpochMillis(candidate.createdAt) <
                DateTime.toEpochMillis(current.createdAt),
          )
          .sort(newestFirst)

const toRolledBackFrom = (
  id: DeploymentSummary["rolledBackFrom"],
  history: ReadonlyArray<DeploymentSummary>,
): RolledBackFrom | null => {
  if (id === null) return null
  const origin = history.find((deployment) => deployment.id === id)
  return origin === undefined ? { id } : { id, commit: shortCommit(origin.commitSha) }
}

/** The deployment a rollback created, with the reference to the deployment it redeploys. */
export const toRolledBack =
  (now: DateTime.Utc) =>
  (detail: DeploymentDetail): RolledBack => ({
    deploy: toDeployRecord(now)(detail),
    rolledBackFrom: toRolledBackFrom(detail.rolledBackFrom, []),
  })

/**
 * One deployment in detail: its steps, runners and build output. `history` is the deployments the
 * console has read for the environment; it supplies the rollback targets and resolves the commit of
 * `rolledBackFrom` when that deployment is in it.
 */
export const toDeploymentPage =
  (now: DateTime.Utc) =>
  (
    input: Readonly<{
      detail: DeploymentDetail
      log: BuildLog
      history: ReadonlyArray<DeploymentSummary>
    }>,
  ): DeploymentPage =>
    DeploymentPage.make({
      deploy: toDeployRecord(now)(input.detail),
      phases: toPhases(input.detail.steps),
      runners: input.detail.runners.map((runner) => ({
        id: runner.id,
        region: runner.region,
        actors: runner.actorCount,
        cpu: `${String(Math.round(runner.cpuPercent))}%`,
        health: runner.health,
      })),
      log: input.log.lines.map((line) => line.text).join("\n"),
      rollbackTargets: rollbackCandidates(input.detail)(input.history).map(toDeployRecord(now)),
      rolledBackFrom: toRolledBackFrom(input.detail.rolledBackFrom, input.history),
    })
