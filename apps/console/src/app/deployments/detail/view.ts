import { Dialog } from "../../shell/model.ts"
import {
  button,
  codeBlock,
  columns,
  dataTable,
  pageBody,
  pageHeader,
  section,
  status,
} from "@akter/ui"
import { rolloutTimeline } from "@akter/ui/charts"
import { formatInteger } from "@akter/ui/geometry"
import { deployStatus } from "../../overview/view.ts"
import * as Routes from "../../navigation/routes.ts"
import { CopiedText, OpenedDialog } from "../../shell/message.ts"
import type { Screen, ScreenInput } from "../../shell/screen.ts"
import type { DeploymentPage } from "../model.ts"

/** One deploy: how its rollout went, the runners it started, and its build log. */
export const deploymentScreen = ({ h, page }: ScreenInput<DeploymentPage>): Screen => {
  const { deploy } = page
  return {
    title: deploy.message,
    crumbs: [
      { label: "Deployments", href: Routes.deployments() },
      { label: deploy.commit, mono: true },
    ],
    actions: [
      button(h, {
        label: "View diff",
        variant: "ghost",
        size: "sm",
        trailingIcon: "external",
        href: `https://github.com/acme/storefront/commit/${deploy.commit}`,
        external: true,
      }),
      button(h, {
        label: "Roll back",
        size: "sm",
        onClick: OpenedDialog({ dialog: Dialog.RollBack({ commit: "77be010" }) }),
        disabled: deploy.status !== "Live",
      }),
    ],
    body: pageBody(h, [
      pageHeader(h, {
        title: deploy.message,
        description: `${deploy.commit} · deployed by ${deploy.author} ${deploy.when} ago · ${deploy.took}`,
        actions: [deployStatus(h)(deploy)],
      }),
      section(h, {
        title: "Rollout",
        meta: `live at ${String(page.liveAt)} s`,
        children: [
          rolloutTimeline(h, {
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
                    formatInteger(runner.actors),
                    runner.cpu,
                    status(h, {
                      tone: runner.healthy ? "live" : "warning",
                      label: runner.healthy ? "Healthy" : "Degraded",
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
                onCopy: CopiedText({ text: page.log, label: "build log" }),
              }),
            ],
          }),
        ],
      }),
    ]),
  }
}
