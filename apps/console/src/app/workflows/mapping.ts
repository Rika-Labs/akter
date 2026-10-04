import type { Schedule as CloudSchedule, TimersSummary, Workflow } from "@akter/cloud-api"
import { formatDuration } from "@akter/ui/geometry"
import { DateTime } from "effect"
import { ago, splitAddress, until } from "../overview/time.ts"
import { type Schedule, type WorkflowRun, WorkflowsPage } from "./model.ts"

/**
 * One workflow as a row. `Waiting` is a wait on an event and `Sleeping` a wait on a timer. The step
 * reads `<name> · <index> of <total>`, with the index written exactly as the contract reports it:
 * it counts from 1, so a run on its first step reads `1 of <total>` and a run on its last reads
 * `<total> of <total>`, and the console never adds or subtracts one.
 */
export const toWorkflowRun =
  (now: DateTime.Utc) =>
  (workflow: Workflow): WorkflowRun => {
    const { actorType, key } = splitAddress(workflow.actor)
    const timer = workflow.waitingFor?.kind === "timer"
    return {
      id: workflow.id,
      workflow: workflow.name,
      actorType,
      key,
      step:
        workflow.step === null
          ? "—"
          : workflow.step.total === null
            ? `${workflow.step.name} · ${String(workflow.step.index)}`
            : `${workflow.step.name} · ${String(workflow.step.index)} of ${String(workflow.step.total)}`,
      waitingFor:
        workflow.waitingFor === null
          ? "—"
          : `${workflow.waitingFor.kind} ${workflow.waitingFor.name}`,
      started: ago(now)(workflow.startedAt),
      status:
        workflow.status === "completed"
          ? "Done"
          : workflow.status === "failed"
            ? "Failed"
            : workflow.status === "running"
              ? "Running"
              : timer
                ? "Sleeping"
                : "Waiting",
    }
  }

/** One schedule as a row; a schedule that has not run yet reads `—`. */
export const toSchedule =
  (now: DateTime.Utc) =>
  (schedule: CloudSchedule): Schedule => ({
    name: schedule.name,
    target: schedule.actorPattern,
    cron: schedule.cron,
    lastRun:
      schedule.lastRun === null
        ? "—"
        : schedule.lastRun.durationMs === null
          ? schedule.lastRun.outcome
          : `${schedule.lastRun.outcome} · ${formatDuration(schedule.lastRun.durationMs)}`,
    nextRun: schedule.nextRunAt === null ? "—" : until(now)(schedule.nextRunAt),
  })

/** Workflows, timers and schedules as the console's page. */
export const toWorkflowsPage =
  (now: DateTime.Utc) =>
  (
    input: Readonly<{
      workflows: ReadonlyArray<Workflow>
      truncated: boolean
      timers: TimersSummary
      schedules: ReadonlyArray<CloudSchedule>
    }>,
  ): WorkflowsPage => {
    const runs = input.workflows.map(toWorkflowRun(now))
    const soonest = input.schedules
      .flatMap((schedule) =>
        schedule.nextRunAt === null ? [] : [{ name: schedule.name, at: schedule.nextRunAt }],
      )
      .sort((left, right) => DateTime.toEpochMillis(left.at) - DateTime.toEpochMillis(right.at))[0]
    return WorkflowsPage.make({
      running: runs.filter((run) => run.status === "Running").length,
      waitingOnEvents: runs.filter((run) => run.status === "Waiting").length,
      truncated: input.truncated,
      timers: input.timers.pending,
      nextTimer:
        input.timers.nextFireAt === null
          ? null
          : formatDuration(
              Math.max(
                0,
                DateTime.toEpochMillis(input.timers.nextFireAt) - DateTime.toEpochMillis(now),
              ),
            ),
      nextSchedule: soonest === undefined ? null : `${soonest.name} ${until(now)(soonest.at)}`,
      runs,
      schedules: input.schedules.map(toSchedule(now)),
    })
  }
