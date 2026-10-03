import {
  button,
  codeBlock,
  columns,
  dataTable,
  emptyState,
  illustration,
  pageBody,
  pageHeader,
  propertyList,
  section,
  statRow,
  status,
  type StatusTone,
  styleAttributes,
} from "@akter/ui"
import { waitingQuay } from "@akter/ui/brand"
import { barChart, lifecycleDiagram, lineChart } from "@akter/ui/charts"
import { formatDuration, formatInteger } from "@akter/ui/geometry"
import * as stylex from "@stylexjs/stylex"
import { colors, space } from "@akter/ui/tokens.stylex"
import type { HtmlBuilder } from "foldkit/html"
import * as Routes from "../navigation/routes.ts"
import { CopiedText } from "../shell/message.ts"
import type { Screen, ScreenInput } from "../shell/screen.ts"
import type { DeploySummary, EmptyProjectPage, OverviewPage } from "./model.ts"
import { seriesWindows, windowName } from "./time.ts"
import { windowMenu } from "./window.ts"

const styles = stylex.create({
  link: {
    color: "inherit",
    textDecoration: { default: "none", ":hover": "underline" },
    textUnderlineOffset: "3px",
  },
  steps: { display: "grid", gap: space.lg, maxWidth: "40rem" },
  quiet: { color: colors.mutedForeground },
  art: { maxWidth: "26rem", width: "100%", justifySelf: "center" },
})

const deployTones: Readonly<Record<DeploySummary["status"], StatusTone>> = {
  Live: "live",
  Drained: "idle",
  "Rolled back": "attention",
  "Rolling out": "pending",
  Failed: "danger",
}

/** A deploy's status word and the dot tone it is drawn with. */
export const deployStatus =
  <Message>(h: HtmlBuilder<Message>) =>
  (deploy: Pick<DeploySummary, "status">) =>
    status(h, { label: deploy.status, tone: deployTones[deploy.status] })

const healthLinks = (page: OverviewPage, sample: boolean): ReadonlyMap<string, string> => {
  const live = page.deploys.find((deploy) => deploy.status === "Live")
  return new Map([
    ["Database", Routes.regions()],
    ["Dead letters", Routes.jobs()],
    [
      "Runners",
      live === undefined || sample
        ? Routes.deployments()
        : Routes.deployment({ commit: live.commit }),
    ],
  ])
}

/** The project overview: headline numbers, throughput, health, latency and recent deploys. */
export const overviewScreen = ({ h, model, page }: ScreenInput<OverviewPage>): Screen => {
  const links = healthLinks(page, model.pageSample)
  const selected =
    page.distribution?.window ??
    seriesWindows.find((window) => window === model.choices["seriesWindow"]) ??
    "24h"
  return {
    title: "Overview",
    crumbs: [{ label: "Overview" }],
    actions: [
      windowMenu(h, { id: "range-menu", selected, disabled: model.pageSample }),
      button(h, { label: "Deploy", variant: "primary", size: "sm", href: Routes.deployments() }),
    ],
    body: pageBody(h, [
      pageHeader(h, { title: "Overview" }),
      statRow(h, {
        label: "Last 24 hours",
        stats: page.stats.map((stat) => ({
          label: stat.label,
          value: stat.value,
          trend: stat.trend.length > 1 ? stat.trend : undefined,
          trendVariant: stat.stepped ? "step" : "primary",
        })),
      }),
      columns(h, {
        layout: "wide-left",
        children: [
          section(h, {
            title: "Throughput",
            meta: "commands per second",
            children: [
              lineChart(h, {
                id: "throughput",
                label: "Commands per second over the last 24 hours",
                categories: page.hours,
                height: 210,
                markers: page.markers,
                series: [
                  {
                    id: "today",
                    label: "Today",
                    values: page.throughput,
                    variant: "primary",
                    area: true,
                  },
                  ...(page.previous.length === 0
                    ? []
                    : [
                        {
                          id: "yesterday",
                          label: "Yesterday",
                          values: page.previous,
                          variant: "secondary" as const,
                        },
                      ]),
                ],
                formatValue: formatInteger,
              }),
            ],
          }),
          section(h, {
            title: "Health",
            children: [
              propertyList(h, {
                ruled: true,
                layout: "wide",
                items: page.health.map((fact) => {
                  const word = status(h, {
                    tone: fact.healthy ? "live" : "attention",
                    label: fact.value,
                  })
                  const href = links.get(fact.label)
                  return {
                    label: fact.label,
                    value:
                      href === undefined
                        ? word
                        : h.a([h.Href(href), ...styleAttributes(h, styles.link)], [word]),
                  }
                }),
              }),
            ],
          }),
        ],
      }),
      columns(h, {
        layout: "even",
        children: [
          section(h, {
            title: "Turn latency",
            meta: `p50 ${formatDuration(page.latency.p50)} · p99 ${formatDuration(page.latency.p99)} · last 24 hours`,
            children: [
              lineChart(h, {
                id: "latency",
                label: "Turn latency, 99th percentile",
                categories: page.latency.hours,
                height: 180,
                series: [
                  {
                    id: "p99",
                    label: "p99",
                    values: page.latency.p99Series,
                    variant: "primary",
                    area: true,
                  },
                ],
                formatValue: formatDuration,
              }),
            ],
          }),
          section(h, {
            title: "Recent deploys",
            actions: [
              button(h, { label: "All deploys", variant: "link", href: Routes.deployments() }),
            ],
            children: [
              dataTable(h, {
                label: "Recent deploys",
                columns: [
                  { key: "commit", label: "Commit", width: "5.5rem", mono: true },
                  { key: "message", label: "Message", width: "minmax(0, 1fr)" },
                  { key: "status", label: "Status", width: "7.5rem", hideBelow: "compact" },
                  { key: "when", label: "When", width: "3rem", align: "end" },
                ],
                rows: page.deploys.map((deploy) => ({
                  key: deploy.commit,
                  href: model.pageSample ? undefined : Routes.deployment({ commit: deploy.commit }),
                  cells: [deploy.commit, deploy.message, deployStatus(h)(deploy), deploy.when],
                })),
              }),
            ],
          }),
        ],
      }),
      ...(page.distribution === undefined
        ? [
            section(h, {
              title: "Turn latency distribution",
              children: [
                h.p(
                  [...styleAttributes(h, styles.quiet)],
                  [
                    "The runtime returned incompatible histogram windows or bucket bounds. No combined distribution is shown.",
                  ],
                ),
              ],
            }),
          ]
        : [
            section(h, {
              title: "Turn latency distribution",
              meta: `${formatInteger(page.distribution.total)} turns · ${windowName[page.distribution.window]}`,
              children:
                page.distribution.total === 0
                  ? [
                      h.p(
                        [...styleAttributes(h, styles.quiet)],
                        ["No turns finished in this window."],
                      ),
                    ]
                  : [
                      barChart(h, {
                        label: `Turns by latency, ${windowName[page.distribution.window]}`,
                        height: 180,
                        xTicks: page.distribution.bars.length,
                        data: page.distribution.bars.map((bar) => ({
                          key: bar.label,
                          label: bar.label,
                          value: bar.count,
                          highlight: bar.tail,
                        })),
                      }),
                    ],
            }),
          ]),
    ]),
  }
}

const deploySteps =
  "# 1 · sign in\n$ bunx akter login\n# 2 · link this folder to the project\n$ bunx akter link\n# 3 · deploy\n$ bunx akter deploy"

/** A project with nothing deployed yet: how to ship the first actor, and what a turn will do. */
export const emptyProjectScreen = ({ h, model, page }: ScreenInput<EmptyProjectPage>): Screen => ({
  title: page.project,
  crumbs: [{ label: "Overview" }],
  actions: [
    button(h, {
      label: "Connect GitHub",
      variant: "secondary",
      size: "sm",
      icon: "github",
      href: Routes.settingsIntegrations(),
    }),
  ],
  body: pageBody(h, [
    pageHeader(h, {
      title: "Ship your first actor",
      description: `${page.project} is ready in ${page.region}. Nothing is running yet.`,
    }),
    columns(h, {
      layout: "wide-left",
      children: [
        section(h, {
          title: "Deploy from your machine",
          children: [
            h.div(
              [...styleAttributes(h, styles.steps)],
              [
                codeBlock(h, {
                  code: deploySteps,
                  language: "shell",
                  onCopy: model.pageSample
                    ? undefined
                    : CopiedText({
                        text: "bunx akter login && bunx akter link && bunx akter deploy",
                        label: "deploy commands",
                      }),
                }),
                h.p(
                  [...styleAttributes(h, styles.quiet)],
                  ["Or connect GitHub and every push to main deploys."],
                ),
              ],
            ),
          ],
        }),
        emptyState(h, {
          title: "Waiting for your first deploy",
          description: "The quay is empty until a deploy starts runners in this region.",
          illustration: h.div(
            [...styleAttributes(h, styles.art)],
            [illustration(h, { drawing: waitingQuay.drawing, viewBox: waitingQuay.viewBox })],
          ),
        }),
      ],
    }),
    section(h, {
      title: "What happens to a command",
      meta: "every turn, in one transaction",
      children: [lifecycleDiagram(h, { id: "empty-lifecycle" })],
    }),
  ]),
})
