import { button, dataTable, pageBody, pageHeader, select, status, styleAttributes } from "@akter/ui"
import { colors, space, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import type { HtmlBuilder } from "foldkit/html"
import { Option } from "effect"
import * as Routes from "../navigation/routes.ts"
import { ChangedTailFilter, type Message, ToggledTail } from "../shell/message.ts"
import type { Screen, ScreenInput } from "../shell/screen.ts"
import type { CommandsPage, TailEntry } from "./model.ts"

const styles = stylex.create({
  link: {
    color: "inherit",
    position: "relative",
    zIndex: 1,
    textDecoration: { default: "none", ":hover": "underline" },
    textUnderlineOffset: "3px",
  },
  quiet: { color: colors.mutedForeground },
  live: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.sm,
    color: colors.mutedForeground,
    fontSize: typography.small,
  },
})

const result = (h: HtmlBuilder<Message>, entry: TailEntry) =>
  entry.result === "ok"
    ? h.span([...styleAttributes(h, styles.quiet)], ["ok"])
    : status(h, { tone: entry.result === "error" ? "attention" : "idle", label: entry.detail })

/**
 * Committed turns, newest first. Live data continues over the hosted stream, and a paused stream
 * refreshes its opening snapshot before reconnecting. Sample data never starts a stream.
 */
export const commandsScreen = ({ h, model, page }: ScreenInput<CommandsPage>): Screen => {
  const entries =
    model.tail.filter === "all"
      ? model.tail.entries
      : model.tail.entries.filter((entry) => entry.actorType === model.tail.filter)
  const newest = model.tail.entries[0]?.sequence ?? 0
  const label = model.pageSample
    ? "Sample"
    : model.tailStatus === "live"
      ? "Live"
      : model.tailStatus === "connecting"
        ? "Connecting"
        : model.tailStatus === "paused"
          ? "Paused"
          : "Snapshot"
  return {
    title: "Commands",
    crumbs: [{ label: "Commands" }],
    actions: [
      select(h, {
        name: "tail-filter",
        label: "Actor type",
        value: model.tail.filter,
        options: [
          { value: "all", label: "All types" },
          ...page.types.map((type) => ({ value: type, label: type })),
        ],
        disabled: model.pageSample,
        onChange: (filter) => ChangedTailFilter({ filter }),
      }),
      ...(!model.pageSample
        ? [
            button(h, {
              label: model.tail.paused ? "Reconnect" : "Pause",
              icon: model.tail.paused ? "play" : "pause",
              size: "sm",
              disabled: model.pageSample,
              onClick: ToggledTail(),
              attributes: [h.AriaPressed(String(model.tail.paused))],
            }),
          ]
        : []),
    ],
    body: pageBody(h, [
      pageHeader(h, {
        title: "Commands",
        actions: [
          h.span(
            [h.AriaLive("polite"), ...styleAttributes(h, styles.live)],
            [
              status(h, {
                tone: model.tailStatus === "live" ? "pending" : "idle",
                label,
              }),
            ],
          ),
        ],
      }),
      Option.match(model.tailError, {
        onNone: () => h.empty,
        onSome: (message) =>
          h.p(
            [h.Role("status"), ...styleAttributes(h, styles.quiet)],
            [
              model.tailStatus === "unavailable"
                ? "Live updates aren’t connected yet. Showing the latest fetched commands."
                : message,
            ],
          ),
      }),
      dataTable(h, {
        label: "Committed turns, newest first",
        density: model.toggles["compactTables"] === true ? "compact" : "default",
        empty: "No turns for this actor type yet.",
        columns: [
          { key: "time", label: "Time", width: "7.25rem", mono: true, muted: true },
          { key: "took", label: "Took", width: "4.5rem", align: "end", hideBelow: "compact" },
          { key: "actor", label: "Actor", width: "minmax(8rem, 1fr)", mono: true },
          {
            key: "command",
            label: "Command",
            width: "minmax(0, 1.6fr)",
            mono: true,
            hideBelow: "narrow",
          },
          { key: "result", label: "Result", width: "minmax(5rem, 9rem)" },
        ],
        rows: entries.map((entry) => ({
          key: String(entry.sequence),
          fresh: entry.sequence > newest - 2 && entry.sequence >= 14,
          tone: entry.result === "replayed" ? "muted" : "default",
          cells: [
            entry.time,
            entry.took,
            model.pageSample
              ? `${entry.actorType}/${entry.key}`
              : h.a(
                  [
                    h.Href(Routes.actor({ actorType: entry.actorType, key: entry.key })),
                    ...styleAttributes(h, styles.link),
                  ],
                  [`${entry.actorType}/${entry.key}`],
                ),
            entry.command,
            result(h, entry),
          ],
        })),
      }),
    ]),
  }
}
