import {
  columns,
  dataTable,
  pageBody,
  pageHeader,
  section,
  statRow,
  status,
  type StatusTone,
} from "@akter/ui"
import { barChart } from "@akter/ui/charts"
import { formatInteger } from "@akter/ui/geometry"
import * as Routes from "../navigation/routes.ts"
import type { Screen, ScreenInput } from "../shell/screen.ts"
import type { WorkflowsPage } from "./model.ts"

const tones: Readonly<Record<WorkflowsPage["runs"][number]["status"], StatusTone>> = {
  Waiting: "attention",
  Running: "pending",
  Sleeping: "idle",
  Done: "idle",
}

/** Workflows and timers: long-running work owned by actors, and the schedules that start it. */
export const workflowsScreen = ({ h, page }: ScreenInput<WorkflowsPage>): Screen => ({
  title: "Workflows",
  crumbs: [{ label: "Workflows" }],
  body: pageBody(h, [
    pageHeader(h, { title: "Workflows & timers" }),
    statRow(h, {
      label: "Workflows and timers",
      stats: [
        {
          label: "Running workflows",
          value: formatInteger(page.running),
          detail: `${formatInteger(page.waitingOnEvents)} waiting on events`,
        },
        {
          label: "Timers pending",
          value: formatInteger(page.timers),
          detail: `next fires in ${page.nextTimer}`,
        },
        {
          label: "Schedules",
          value: String(page.schedules.length),
          detail: "next: nightly at 02:00 UTC",
        },
      ],
    }),
    section(h, {
      title: "Workflows",
      children: [
        dataTable(h, {
          label: "Workflows",
          columns: [
            { key: "workflow", label: "Workflow", width: "minmax(6rem, 0.8fr)", mono: true },
            {
              key: "actor",
              label: "Actor",
              width: "minmax(8rem, 1.2fr)",
              mono: true,
              hideBelow: "compact",
            },
            { key: "step", label: "Step", width: "minmax(0, 1fr)", hideBelow: "narrow" },
            {
              key: "waiting",
              label: "Waiting for",
              width: "minmax(0, 1fr)",
              muted: true,
              hideBelow: "narrow",
            },
            {
              key: "started",
              label: "Started",
              width: "4.5rem",
              align: "end",
              hideBelow: "compact",
            },
            { key: "status", label: "Status", width: "6.5rem" },
          ],
          rows: page.runs.map((run) => ({
            key: run.id,
            href: Routes.actor({ actorType: run.actorType, key: run.key }),
            cells: [
              run.workflow,
              `${run.actorType}/${run.key}`,
              run.step,
              run.waitingFor,
              run.started,
              status(h, { tone: tones[run.status], label: run.status }),
            ],
          })),
        }),
      ],
    }),
    columns(h, {
      layout: "wide-left",
      children: [
        section(h, {
          title: "Schedules",
          meta: "cron",
          children: [
            dataTable(h, {
              label: "Schedules",
              columns: [
                { key: "name", label: "Name", width: "minmax(5rem, 0.7fr)", mono: true },
                {
                  key: "target",
                  label: "Target",
                  width: "minmax(0, 1.3fr)",
                  mono: true,
                  hideBelow: "compact",
                },
                {
                  key: "cron",
                  label: "Cron",
                  width: "minmax(6rem, 0.9fr)",
                  mono: true,
                  muted: true,
                },
                { key: "last", label: "Last run", width: "minmax(0, 1fr)", hideBelow: "narrow" },
                { key: "next", label: "Next", width: "5.5rem", align: "end" },
              ],
              rows: page.schedules.map((schedule) => ({
                key: schedule.name,
                cells: [
                  schedule.name,
                  schedule.target,
                  schedule.cron,
                  schedule.lastRun,
                  schedule.nextRun,
                ],
              })),
            }),
          ],
        }),
        section(h, {
          title: "Timers fired",
          meta: "per 30 minutes",
          children: [
            barChart(h, {
              label: "Timers fired per half hour, last 24 hours",
              height: 150,
              xTicks: 4,
              data: page.timersFired.map((value, index) => ({
                key: String(index),
                label: page.hours[index] ?? "",
                value,
                highlight: index === page.timersFired.length - 1,
              })),
            }),
          ],
        }),
      ],
    }),
  ]),
})
