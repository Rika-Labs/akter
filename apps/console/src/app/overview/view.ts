import {
  button,
  codeBlock,
  columns,
  dataTable,
  dropdownMenu,
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
import { histogram, lifecycleDiagram, lineChart } from "@akter/ui/charts"
import { formatInteger } from "@akter/ui/geometry"
import * as stylex from "@stylexjs/stylex"
import { colors, space } from "@akter/ui/tokens.stylex"
import type { HtmlBuilder } from "foldkit/html"
import * as Routes from "../navigation/routes.ts"
import { CopiedText, type Message, RequestedHref } from "../shell/message.ts"
import type { Screen, ScreenInput } from "../shell/screen.ts"
import type { DeploySummary, EmptyProjectPage, OverviewPage } from "./model.ts"

const styles = stylex.create({
  link: {
    color: "inherit",
    textDecoration: { default: "none", ":hover": "underline" },
    textUnderlineOffset: "3px",
  },
  steps: { display: "grid", gap: space.lg, maxWidth: "40rem" },
  quiet: { color: colors.mutedForeground },
  art: { maxWidth: "26rem", width: "100%", justifySelf: "center" },
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    height: "1.75rem",
    paddingInline: "0.625rem",
    borderRadius: "6px",
    color: { default: colors.mutedForeground, ":hover": colors.foreground },
    backgroundColor: { default: "transparent", ":hover": colors.accent },
  },
})

const deployTones: Readonly<Record<DeploySummary["status"], StatusTone>> = {
  Live: "live",
  Drained: "idle",
  "Rolled back": "attention",
  "Rolling out": "pending",
}

/** A deploy's status word and the dot tone it is drawn with. */
export const deployStatus =
  <Message>(h: HtmlBuilder<Message>) =>
  (deploy: Pick<DeploySummary, "status">) =>
    status(h, { label: deploy.status, tone: deployTones[deploy.status] })

const healthLinks = new Map([
  ["Database", Routes.regions()],
  ["Dead letters", Routes.jobs()],
  ["Runners", Routes.deployment({ commit: "a3f9c21" })],
])

const rangeMenu = (h: HtmlBuilder<Message>) =>
  dropdownMenu(h, {
    id: "range-menu",
    label: "Time range",
    placement: "below-end",
    entries: [
      { kind: "item", label: "Last hour", onSelect: RequestedHref({ href: Routes.overview() }) },
      {
        kind: "item",
        label: "Last 24 hours",
        checked: true,
        onSelect: RequestedHref({ href: Routes.overview() }),
      },
      { kind: "item", label: "Last 7 days", onSelect: RequestedHref({ href: Routes.overview() }) },
    ],
    trigger: (attributes) =>
      h.button(
        [
          h.Type("button"),
          ...attributes,
          h.AriaLabel("Time range: last 24 hours"),
          ...styleAttributes(h, styles.trigger),
        ],
        ["24h"],
      ),
  })

/** The project overview: headline numbers, throughput, health, latency and recent deploys. */
export const overviewScreen = ({ h, page }: ScreenInput<OverviewPage>): Screen => ({
  title: "Overview",
  crumbs: [{ label: "Overview" }],
  actions: [
    rangeMenu(h),
    button(h, { label: "Deploy", variant: "primary", size: "sm", href: Routes.deployments() }),
  ],
  body: pageBody(h, [
    pageHeader(h, { title: "Overview" }),
    statRow(h, {
      label: "Last 24 hours",
      stats: page.stats.map((stat) => ({
        label: stat.label,
        value: stat.value,
        trend: stat.trend,
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
                {
                  id: "yesterday",
                  label: "Yesterday",
                  values: page.previous,
                  variant: "secondary",
                },
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
                const href = healthLinks.get(fact.label)
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
          meta: "last hour",
          children: [
            histogram(h, {
              label: "Turn latency distribution",
              buckets: page.latency,
              quantiles: [
                { label: "p50", quantile: 0.5 },
                { label: "p99", quantile: 0.99 },
              ],
              formatBound: (value) =>
                value < 1 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`,
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
                href: Routes.deployment({ commit: deploy.commit }),
                cells: [deploy.commit, deploy.message, deployStatus(h)(deploy), deploy.when],
              })),
            }),
          ],
        }),
      ],
    }),
  ]),
})

const deploySteps =
  "# 1 · sign in\n$ bunx akter login\n# 2 · link this folder to the project\n$ bunx akter link\n# 3 · deploy\n$ bunx akter deploy"

/** A project with nothing deployed yet: how to ship the first actor, and what a turn will do. */
export const emptyProjectScreen = ({ h, page }: ScreenInput<EmptyProjectPage>): Screen => ({
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
                  onCopy: CopiedText({
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
