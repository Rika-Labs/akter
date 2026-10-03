import { Dialog } from "../../shell/model.ts"
import { barChart, lineChart } from "@akter/ui/charts"
import {
  button,
  columns,
  dataTable,
  pageBody,
  pageHeader,
  section,
  statRow,
  status,
} from "@akter/ui"
import { formatCompact, formatInteger } from "@akter/ui/geometry"
import * as Routes from "../../navigation/routes.ts"
import { OpenedDialog } from "../../shell/message.ts"
import type { Screen, ScreenInput } from "../../shell/screen.ts"
import type { ActorTypePage } from "../model.ts"

/** One actor type: its numbers, its traffic, its commands and its hottest instances. */
export const actorTypeScreen = ({ h, page }: ScreenInput<ActorTypePage>): Screen => {
  const { summary } = page
  return {
    title: summary.name,
    crumbs: [
      { label: "Actors", href: Routes.actors() },
      { label: summary.name, mono: true },
    ],
    actions: [
      button(h, {
        label: "Send command",
        size: "sm",
        onClick: OpenedDialog({
          dialog: Dialog.SendCommand({
            address: `${summary.name}/${page.instances[0]?.key ?? "key"}`,
          }),
        }),
      }),
    ],
    body: pageBody(h, [
      pageHeader(h, {
        title: summary.name,
        mono: true,
        description: `Accepts ${summary.commands.join(", ")}.`,
      }),
      statRow(h, {
        label: `${summary.name} totals`,
        stats: [
          { label: "Instances", value: formatCompact(summary.instances) },
          { label: "Awake", value: formatInteger(summary.awake) },
          {
            label: "Commands / s",
            value: formatInteger(summary.perSecond),
            trend: page.perSecond.slice(-40),
          },
          { label: "p99 turn", value: summary.p99 },
        ],
      }),
      columns(h, {
        layout: "wide-left",
        children: [
          section(h, {
            title: "Commands per second",
            meta: "last 24 hours",
            children: [
              lineChart(h, {
                id: `type-${summary.name}`,
                label: `${summary.name} commands per second`,
                categories: page.hours,
                height: 180,
                series: [
                  {
                    id: "rate",
                    label: summary.name,
                    values: page.perSecond,
                    variant: "primary",
                    area: true,
                  },
                ],
                formatValue: formatInteger,
              }),
            ],
          }),
          section(h, {
            title: "By command",
            meta: "today",
            children: [
              barChart(h, {
                label: `${summary.name} commands today`,
                orientation: "horizontal",
                data: page.commands.map((command, index) => ({
                  key: command.name,
                  label: command.name,
                  value: command.today,
                  highlight: index === 0,
                })),
              }),
            ],
          }),
        ],
      }),
      section(h, {
        title: "Instances",
        meta: "busiest first",
        children: [
          dataTable(h, {
            label: `${summary.name} instances`,
            columns: [
              { key: "key", label: "Key", width: "minmax(7rem, 1.4fr)", mono: true },
              { key: "status", label: "Status", width: "6.5rem" },
              {
                key: "generation",
                label: "Generation",
                width: "6rem",
                align: "end",
                hideBelow: "narrow",
              },
              {
                key: "mailbox",
                label: "Mailbox",
                width: "5rem",
                align: "end",
                hideBelow: "compact",
              },
              {
                key: "runner",
                label: "Runner",
                width: "minmax(0, 1fr)",
                muted: true,
                hideBelow: "narrow",
              },
              { key: "last", label: "Last turn", width: "5rem", align: "end" },
            ],
            rows: page.instances.map((instance) => ({
              key: instance.key,
              href: Routes.actor({ actorType: summary.name, key: instance.key }),
              cells: [
                instance.key,
                status(h, {
                  tone: instance.awake ? "live" : "idle",
                  label: instance.awake ? "Awake" : "Asleep",
                }),
                String(instance.generation),
                String(instance.mailbox),
                instance.runner,
                instance.lastTurn,
              ],
            })),
          }),
        ],
      }),
    ]),
  }
}
