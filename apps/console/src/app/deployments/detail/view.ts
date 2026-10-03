import { Dialog } from "../../shell/model.ts"
import {
  button,
  codeBlock,
  columns,
  dataTable,
  pageBody,
  pageHeader,
  section,
  select,
  status,
  type StatusTone,
} from "@akter/ui"
import { rolloutTimeline } from "@akter/ui/charts"
import { formatDuration, formatInteger } from "@akter/ui/geometry"
import { deployStatus } from "../../overview/view.ts"
import * as Routes from "../../navigation/routes.ts"
import { ChoseSetting, CopiedText, OpenedDialog } from "../../shell/message.ts"
import type { Screen, ScreenInput } from "../../shell/screen.ts"
import type { DeploymentPage, Runner } from "../model.ts"

const healthTones: Readonly<Record<Runner["health"], StatusTone>> = {
  healthy: "live",
  starting: "pending",
  draining: "idle",
  unhealthy: "warning",
}

const healthLabels: Readonly<Record<Runner["health"], string>> = {
  healthy: "Healthy",
  starting: "Starting",
  draining: "Draining",
  unhealthy: "Unhealthy",
}

const rollbackTargetKey = "rollbackTarget"

/** One deploy: how its rollout went, the runners it started, and its build log. */
export const deploymentScreen = ({ h, model, page }: ScreenInput<DeploymentPage>): Screen => {
  const { deploy, rolledBackFrom } = page
  const target =
    page.rollbackTargets.find((candidate) => candidate.id === model.choices[rollbackTargetKey]) ??
    page.rollbackTargets[0]
  return {
    title: deploy.message,
    crumbs: [
      { label: "Deployments", href: Routes.deployments() },
      { label: deploy.commit, mono: true },
    ],
    actions: [
      ...(page.diffUrl === undefined || model.pageSample
        ? []
        : [
            button(h, {
              label: "View diff",
              variant: "ghost",
              size: "sm",
              trailingIcon: "external",
              href: page.diffUrl,
              external: true,
            }),
          ]),
      ...(target === undefined
        ? []
        : [
            select(h, {
              name: "rollback-target",
              label: "Roll back to",
              value: target.id,
              size: "sm",
              disabled: model.pageSample,
              options: page.rollbackTargets.map((candidate) => ({
                value: candidate.id,
                label: `${candidate.commit} · ${candidate.message} · ${candidate.when}`,
              })),
              onChange: (value) => ChoseSetting({ key: rollbackTargetKey, value }),
            }),
          ]),
      button(h, {
        label: "Roll back",
        size: "sm",
        onClick:
          target === undefined
            ? undefined
            : OpenedDialog({ dialog: Dialog.RollBack({ id: target.id, commit: target.commit }) }),
        disabled: model.pageSample || deploy.status !== "Live" || target === undefined,
      }),
    ],
    body: pageBody(h, [
      pageHeader(h, {
        title: deploy.message,
        description: `${deploy.commit} · deployed by ${deploy.author} ${deploy.when === "now" ? "just now" : `${deploy.when} ago`} · ${deploy.took}${rolledBackFrom === null ? "" : ` · rolled back from ${rolledBackFrom.commit ?? rolledBackFrom.id}`}`,
        actions: [deployStatus(h)(deploy)],
      }),
      section(h, {
        title: "Rollout",
        meta: page.liveAt === undefined ? undefined : `live at ${String(page.liveAt)} s`,
        children: [
          page.shift === undefined || page.liveAt === undefined
            ? dataTable(h, {
                label: "Rollout steps",
                columns: [
                  { key: "step", label: "Step", width: "minmax(0, 1fr)" },
                  { key: "status", label: "Status", width: "6rem", muted: true },
                  { key: "took", label: "Took", width: "5rem", align: "end" },
                  { key: "detail", label: "Detail", width: "minmax(0, 1.6fr)", muted: true },
                ],
                rows: page.phases.map((phase) => ({
                  key: phase.id,
                  cells: [
                    phase.label,
                    phase.status ?? "",
                    formatDuration((phase.end - phase.start) * 1000),
                    phase.detail,
                  ],
                })),
              })
            : rolloutTimeline(h, {
                label: `Rollout of ${deploy.commit}`,
                phases: page.phases,
                shift: {
                  start: page.shift.start,
                  end: page.shift.end,
                  label: "Turns on new runners",
                  detail: `${formatInteger(page.shift.moved)} actors moved`,
                },
                live: { at: page.liveAt, label: `Live at ${String(page.liveAt)} s` },
                formatSeconds: (seconds) => `${String(Math.round(seconds))} s`,
              }),
        ],
      }),
      columns(h, {
        layout: "even",
        children: [
          section(h, {
            title: "Runners",
            children: [
              dataTable(h, {
                label: "Runners",
                columns: [
                  { key: "id", label: "Runner", width: "4rem", mono: true },
                  { key: "region", label: "Region", width: "minmax(0, 1fr)", muted: true },
                  { key: "actors", label: "Actors", width: "5rem", align: "end" },
                  { key: "cpu", label: "CPU", width: "3.5rem", align: "end" },
                  { key: "status", label: "Status", width: "6rem" },
                ],
                rows: page.runners.map((runner) => ({
                  key: runner.id,
                  cells: [
                    runner.id,
                    runner.region,
                    runner.actors === null ? "—" : formatInteger(runner.actors),
                    runner.cpu,
                    status(h, {
                      tone: healthTones[runner.health],
                      label: healthLabels[runner.health],
                    }),
                  ],
                })),
              }),
            ],
          }),
          section(h, {
            title: "Build log",
            children: [
              codeBlock(h, {
                code: page.log,
                language: "log",
                size: "small",
                onCopy: model.pageSample
                  ? undefined
                  : CopiedText({ text: page.log, label: "build log" }),
              }),
            ],
          }),
        ],
      }),
    ]),
  }
}
