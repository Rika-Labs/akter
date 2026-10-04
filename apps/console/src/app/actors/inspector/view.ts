import { Dialog } from "../../shell/model.ts"
import {
  activityFeed,
  button,
  codeBlock,
  dataTable,
  emptyState,
  pageBody,
  pageHeader,
  propertyList,
  section,
  status,
  type StatusTone,
  styleAttributes,
  tabs,
} from "@akter/ui"
import { borders, colors, conditions, dimensions, space } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { Match } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute } from "../../navigation/routes.ts"
import * as Routes from "../../navigation/routes.ts"
import { CopiedText, type Message, OpenedDialog } from "../../shell/message.ts"
import type { Screen, ScreenInput } from "../../shell/screen.ts"
import {
  type ActorPage,
  type InspectorTab,
  inspectorTab,
  inspectorTabs,
  type MissingActorPage,
} from "../model.ts"

const styles = stylex.create({
  split: {
    display: "grid",
    gridTemplateColumns: {
      default: `minmax(0, 1fr) ${dimensions.aside}`,
      [conditions.narrow]: "minmax(0, 1fr)",
    },
    flex: "1",
    minHeight: 0,
  },
  main: {
    display: "flex",
    flexDirection: "column",
    gap: "1.75rem",
    minWidth: 0,
    paddingBlock: { default: "1.75rem", [conditions.narrow]: space.lg },
    paddingInline: { default: space.xxl, [conditions.narrow]: space.lg },
    paddingBlockEnd: space.huge,
  },
  aside: {
    display: "grid",
    alignContent: "start",
    gap: space.xl,
    paddingBlock: { default: space.xl, [conditions.narrow]: space.lg },
    paddingInline: { default: "1.25rem", [conditions.narrow]: space.lg },
    borderInlineStartWidth: { default: borders.hairline, [conditions.narrow]: 0 },
    borderBlockStartWidth: { default: 0, [conditions.narrow]: borders.hairline },
    borderStyle: "solid",
    borderColor: colors.border,
  },
  panel: { display: "grid", gap: space.lg, minWidth: 0 },
  muted: { color: colors.mutedForeground },
  strong: { fontWeight: 500 },
})

const labels: Readonly<Record<InspectorTab, string>> = {
  state: "State",
  rows: "Rows",
  receipts: "Receipts",
  events: "Events",
  jobs: "Jobs",
  connections: "Connections",
}

const jobTones: Readonly<Record<ActorPage["jobs"][number]["status"], StatusTone>> = {
  queued: "idle",
  running: "pending",
  retrying: "pending",
  done: "idle",
  dead: "danger",
}

const jobLabels: Readonly<Record<ActorPage["jobs"][number]["status"], string>> = {
  queued: "Queued",
  running: "Running",
  retrying: "Retrying",
  done: "Done",
  dead: "Dead",
}

/** A count or flag the runner does not report reads as unknown, never as zero. */
const known = (value: number | null) => (value === null ? "—" : String(value))

const panel = (
  h: HtmlBuilder<Message>,
  page: ActorPage,
  tab: InspectorTab,
  sample: boolean,
): Html =>
  Match.value(tab).pipe(
    Match.when("state", () =>
      page.state === null
        ? emptyState(h, {
            title: "Committed state isn’t readable",
            description: "An entry of this actor’s state doesn’t decode, so none of it is shown.",
            align: "start",
          })
        : codeBlock(h, {
            title:
              page.turn === null
                ? "Committed state"
                : `Committed state · turn ${String(page.turn)}`,
            code: page.state,
            language: "json",
            onCopy: sample ? undefined : CopiedText({ text: page.state, label: "state" }),
          }),
    ),
    Match.when("rows", () =>
      page.tables === null
        ? emptyState(h, {
            title: "Owned rows aren’t reported",
            description:
              "The runner’s inspector reads state, receipts, events and jobs, not owned tables.",
            align: "start",
          })
        : page.tables.length === 0
          ? emptyState(h, {
              title: "No owned tables",
              description: "This actor keeps its data in state.",
              align: "start",
            })
          : h.div(
              [...styleAttributes(h, styles.panel)],
              page.tables.map((table) =>
                section(h, {
                  title: table.name,
                  meta: `owned table · ${String(table.rows.length)} rows`,
                  children: [
                    dataTable(h, {
                      label: table.name,
                      columns: table.columns.map((name, index) => ({
                        key: name,
                        label: name,
                        width: index === 0 ? "minmax(0, 1fr)" : "7rem",
                        mono: true,
                        align: index === 0 ? "start" : "end",
                      })),
                      rows: table.rows.map((row, index) => ({
                        key: String(index),
                        cells: row.cells,
                      })),
                    }),
                  ],
                }),
              ),
            ),
    ),
    Match.when("receipts", () =>
      dataTable(h, {
        label: "Receipts",
        empty: "No receipts held",
        columns: [
          { key: "id", label: "Command id", width: "7rem", mono: true },
          { key: "command", label: "Command", width: "minmax(0, 1fr)", mono: true },
          { key: "result", label: "Result", width: "minmax(0, 1fr)", mono: true },
          { key: "at", label: "At", width: "5.5rem", align: "end", hideBelow: "compact" },
        ],
        rows: page.receipts.map((receipt, index) => ({
          key: `${receipt.commandId}-${String(index)}`,
          tone: receipt.replayed ? "muted" : "default",
          cells: [receipt.commandId, receipt.command, receipt.result, receipt.at],
        })),
      }),
    ),
    Match.when("events", () =>
      dataTable(h, {
        label: "Events",
        empty: "No events emitted",
        columns: [
          { key: "cursor", label: "Cursor", width: "6rem", mono: true },
          { key: "name", label: "Event", width: "minmax(0, 1fr)", mono: true },
          { key: "subscribers", label: "Subscribers", width: "6.5rem", align: "end" },
        ],
        rows: page.events.map((event) => ({
          key: `${event.name}-${event.cursor}`,
          cells: [event.cursor, event.name, known(event.subscribers)],
        })),
      }),
    ),
    Match.when("jobs", () =>
      dataTable(h, {
        label: "Jobs",
        empty: "No pending or dead jobs",
        columns: [
          { key: "id", label: "Job", width: "6rem", mono: true },
          { key: "name", label: "Type", width: "minmax(0, 1fr)", mono: true },
          {
            key: "attempts",
            label: "Attempts",
            width: "5.5rem",
            align: "end",
            hideBelow: "compact",
          },
          { key: "status", label: "Status", width: "6.5rem" },
        ],
        rows: page.jobs.map((job) => ({
          key: job.id,
          cells: [
            job.id,
            job.name,
            String(job.attempts),
            status(h, { tone: jobTones[job.status], label: jobLabels[job.status] }),
          ],
        })),
      }),
    ),
    Match.orElse(() =>
      propertyList(h, {
        ruled: true,
        layout: "wide",
        items: [
          { label: "Sockets", value: known(page.connections.sockets) },
          { label: "Event feed cursor", value: page.connections.feedCursor ?? "—", mono: true },
        ],
      }),
    ),
  )

/** The actor inspector: one instance's state, rows, receipts, events, jobs and live connections. */
export const actorScreen = ({ h, model, page }: ScreenInput<ActorPage>): Screen => {
  const address = `${page.actorType}/${page.key}`
  const tab = inspectorTab(AppRoute.isAnyOf(["Actor"])(model.route) ? model.route.tab : undefined)
  return {
    title: address,
    crumbs: [
      { label: "Actors", href: Routes.actors() },
      { label: page.actorType, href: Routes.actorType({ actorType: page.actorType }) },
      { label: page.key, mono: true },
    ],
    actions: [
      button(h, {
        label: "Copy address",
        variant: "ghost",
        size: "sm",
        disabled: model.pageSample && page.commandScope === undefined,
        onClick: CopiedText({ text: address, label: "address" }),
      }),
      button(h, {
        label: "Send command",
        size: "sm",
        disabled: page.commandScope === undefined,
        onClick:
          page.commandScope === undefined
            ? undefined
            : OpenedDialog({ dialog: Dialog.SendCommand({ address, scope: page.commandScope }) }),
      }),
    ],
    body: h.div(
      [...styleAttributes(h, styles.split)],
      [
        h.div(
          [...styleAttributes(h, styles.main)],
          [
            pageHeader(h, { title: address, mono: true }),
            tabs(h, {
              label: "Inspector",
              selected: tab,
              items: inspectorTabs.map((id) => ({
                id,
                label: labels[id],
                href: Routes.actor({
                  actorType: page.actorType,
                  key: page.key,
                  tab: id === "state" ? undefined : id,
                }),
              })),
            }),
            h.div(
              [h.DataAttribute("panel", tab), ...styleAttributes(h, styles.panel)],
              [panel(h, page, tab, model.pageSample)],
            ),
            section(h, {
              title: "Activity",
              meta: "this turn and its follow-ups",
              children: [
                page.activity === null
                  ? emptyState(h, {
                      title: "Activity isn’t reported",
                      description: "The runner doesn’t keep a timeline for this actor.",
                      align: "start",
                    })
                  : activityFeed(h, {
                      label: `${address} activity`,
                      entries: page.activity.map((entry) => ({
                        key: entry.key,
                        tone: entry.committed ? "live" : "idle",
                        title: [
                          h.span([...styleAttributes(h, styles.strong)], [entry.subject]),
                          ` ${entry.title}`,
                        ],
                        detail: entry.detail,
                        time: entry.time,
                      })),
                    }),
              ],
            }),
          ],
        ),
        h.aside(
          [h.AriaLabel("Properties"), ...styleAttributes(h, styles.aside)],
          [
            propertyList(h, {
              items: [
                {
                  label: "Status",
                  value:
                    page.awake === null
                      ? "—"
                      : status(h, {
                          tone: page.awake ? "live" : "idle",
                          label: page.awake ? "Awake" : "Asleep",
                        }),
                },
                { label: "Type", value: page.actorType },
                { label: "Generation", value: String(page.generation) },
                { label: "Turn", value: known(page.turn) },
                { label: "Runner", value: page.runner, mono: true },
                { label: "Region", value: page.region },
                { label: "Tenant", value: page.tenant },
                { label: "Mailbox", value: known(page.mailbox) },
                { label: "Sockets", value: known(page.connections.sockets) },
              ],
            }),
          ],
        ),
      ],
    ),
  }
}

/**
 * An address no command has reached yet. Nothing is wrong with it: the command that creates the
 * actor brings it into being, so the page offers to send that first command to this address.
 */
export const missingActorScreen = ({ h, page }: ScreenInput<MissingActorPage>): Screen => {
  const address = `${page.actorType}/${page.key}`
  return {
    title: address,
    crumbs: [
      { label: "Actors", href: Routes.actors() },
      { label: page.actorType, href: Routes.actorType({ actorType: page.actorType }) },
      { label: page.key, mono: true },
    ],
    body: pageBody(h, [
      emptyState(h, {
        title: `${address} hasn’t received a command yet`,
        description:
          "Actors come into being with their first command. Send the command that creates this one and the inspector shows it from its first turn.",
        actions: [
          button(h, {
            label: "Send first command",
            variant: "primary",
            onClick: OpenedDialog({
              dialog: Dialog.SendCommand({ address, scope: page.commandScope }),
            }),
          }),
        ],
      }),
    ]),
  }
}
