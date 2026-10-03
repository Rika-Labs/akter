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
import { formatCompact, formatDuration, formatInteger } from "@akter/ui/geometry"
import * as Routes from "../../navigation/routes.ts"
import { OpenedDialog } from "../../shell/message.ts"
import type { Screen, ScreenInput } from "../../shell/screen.ts"
import { windowName } from "../../overview/time.ts"
import { windowMenu } from "../../overview/window.ts"
import type { ActorTypePage } from "../model.ts"

/** One actor type: its numbers, its traffic and command volumes over the selected window, and its instances. */
export const actorTypeScreen = ({ h, model, page }: ScreenInput<ActorTypePage>): Screen => {
  const { summary, activity } = page
  const first = page.instances[0]
  return {
    title: summary.name,
    crumbs: [
      { label: "Actors", href: Routes.actors() },
      { label: summary.name, mono: true },
    ],
    actions: [
      windowMenu(h, { id: "range-menu", selected: activity.window, disabled: model.pageSample }),
      ...(first === undefined
        ? []
        : [
            button(h, {
              label: "Send command",
              size: "sm",
              disabled: model.pageSample || page.commandScope === undefined,
              onClick:
                page.commandScope === undefined
                  ? undefined
                  : OpenedDialog({
                      dialog: Dialog.SendCommand({
                        address: `${summary.name}/${first.key}`,
                        scope: page.commandScope,
                      }),
                    }),
            }),
          ]),
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
            value: formatInteger(summary.commandsPerSecond),
            trend: activity.perSecond.slice(-40),
          },
          {
            label: "p99 turn",
            value: summary.commandsPerSecond === 0 ? "—" : formatDuration(summary.p99Ms),
          },
        ],
      }),
      columns(h, {
        layout: "wide-left",
        children: [
          section(h, {
            title: "Commands per second",
            meta: windowName[activity.window],
            children: [
              lineChart(h, {
                id: `type-${summary.name}`,
                label: `${summary.name} commands per second, ${windowName[activity.window]}`,
                categories: activity.hours,
                height: 180,
                series: [
                  {
                    id: "rate",
                    label: summary.name,
                    values: activity.perSecond,
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
            meta: windowName[activity.window],
            children: [
              barChart(h, {
                label: `${summary.name} commands, ${windowName[activity.window]}`,
                orientation: "horizontal",
                data: activity.commands.map((command, index) => ({
                  key: command.name,
                  label: command.name,
                  value: command.count,
                  highlight: index === 0,
                })),
              }),
            ],
          }),
        ],
      }),
      section(h, {
        title: "Instances",
        meta: `${formatInteger(page.instances.length)} shown`,
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
                key: "command",
                label: "Last command",
                width: "minmax(0, 1fr)",
                mono: true,
                muted: true,
                hideBelow: "narrow",
              },
              { key: "last", label: "Last turn", width: "5rem", align: "end" },
            ],
            rows: page.instances.map((instance) => ({
              key: instance.key,
              href: model.pageSample
                ? undefined
                : Routes.actor({ actorType: summary.name, key: instance.key }),
              cells: [
                instance.key,
                status(h, {
                  tone: instance.awake ? "live" : "idle",
                  label: instance.awake ? "Awake" : "Asleep",
                }),
                String(instance.generation),
                instance.lastCommand,
                instance.lastTurn,
              ],
            })),
          }),
        ],
      }),
    ]),
  }
}
