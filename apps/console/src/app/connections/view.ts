import { columns, dataTable, pageBody, pageHeader, section, statRow } from "@akter/ui"
import { lineChart, stackedBar } from "@akter/ui/charts"
import { formatCompact, formatInteger } from "@akter/ui/geometry"
import * as Routes from "../navigation/routes.ts"
import type { Screen, ScreenInput } from "../shell/screen.ts"
import type { ConnectionsPage } from "./model.ts"

/** Live clients: open sockets, sockets parked while their actors sleep, streams and feeds. */
export const connectionsScreen = ({ h, page }: ScreenInput<ConnectionsPage>): Screen => ({
  title: "Connections",
  crumbs: [{ label: "Connections" }],
  body: pageBody(h, [
    pageHeader(h, { title: "Connections" }),
    statRow(h, {
      label: "Connections",
      stats: [
        { label: "Open sockets", value: formatInteger(page.sockets), trend: page.open.slice(-40) },
        {
          label: "Parked",
          value: formatInteger(page.parked),
          detail: "held while their actors sleep",
        },
        { label: "SSE streams", value: formatInteger(page.streams) },
        { label: "Replay gaps", value: String(page.replayGaps), detail: "last 24 hours" },
      ],
    }),
    columns(h, {
      layout: "wide-left",
      children: [
        section(h, {
          title: "Open and parked",
          meta: "last 24 hours",
          children: [
            lineChart(h, {
              id: "connections",
              label: "Open and parked sockets over the last 24 hours",
              categories: page.hours,
              height: 200,
              series: [
                { id: "open", label: "Open", values: page.open, variant: "primary", area: true },
                { id: "parked", label: "Parked", values: page.parkedSeries, variant: "secondary" },
              ],
              formatValue: formatCompact,
            }),
          ],
        }),
        section(h, {
          title: "Right now",
          children: [
            stackedBar(h, {
              label: "Sockets by state",
              format: formatInteger,
              segments: [
                { label: "Active", value: page.sockets - page.parked, tone: "ink" },
                { label: "Parked", value: page.parked, tone: "muted" },
              ],
            }),
          ],
        }),
      ],
    }),
    section(h, {
      title: "By actor type",
      children: [
        dataTable(h, {
          label: "Connections by actor type",
          columns: [
            { key: "type", label: "Type", width: "minmax(0, 1fr)", mono: true },
            { key: "sockets", label: "Sockets", width: "6rem", align: "end" },
            { key: "parked", label: "Parked", width: "6rem", align: "end" },
            {
              key: "share",
              label: "Parked share",
              width: "7rem",
              align: "end",
              hideBelow: "compact",
            },
            {
              key: "streams",
              label: "Streams",
              width: "5.5rem",
              align: "end",
              hideBelow: "narrow",
            },
          ],
          rows: page.byType.map((row) => ({
            key: row.actorType,
            href: Routes.actorType({ actorType: row.actorType }),
            cells: [
              row.actorType,
              formatInteger(row.sockets),
              formatInteger(row.parked),
              `${Math.round((row.parked / row.sockets) * 100)}%`,
              formatInteger(row.streams),
            ],
          })),
        }),
      ],
    }),
  ]),
})
