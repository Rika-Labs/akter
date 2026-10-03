import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { Children, SlotConfig } from "../design/contracts.ts"
import { colors, space, typography } from "../tokens.stylex.ts"
import { statusDot, type StatusTone } from "./status.ts"

const styles = stylex.create({
  list: { display: "flex", flexDirection: "column" },
  entry: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "1.125rem minmax(0, 1fr) auto",
    columnGap: "0.625rem",
    paddingBlock: space.sm,
  },
  marker: {
    position: "relative",
    display: "flex",
    justifyContent: "center",
    paddingBlockStart: "0.3125rem",
  },
  rail: {
    position: "absolute",
    insetBlockStart: "1.125rem",
    insetBlockEnd: "-0.9rem",
    insetInlineStart: "50%",
    width: "1px",
    backgroundColor: colors.border,
  },
  copy: { display: "grid", gap: space.xxs, minWidth: 0 },
  title: { overflowWrap: "anywhere" },
  detail: { color: colors.mutedForeground, fontSize: typography.caption },
  time: {
    color: colors.subtleForeground,
    fontSize: typography.caption,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
})

/** One thing that happened: a marker, a sentence, an optional detail line, and when. */
export interface ActivityEntry {
  readonly key: string
  readonly tone: StatusTone
  readonly title: Children
  readonly detail?: string
  readonly time: string
  readonly datetime?: string
}

/** A vertical feed of events joined by a hairline rail; filled markers are commits. */
export type ActivityFeedConfig<Message> = SlotConfig<Message> &
  Readonly<{
    label: string
    entries: ReadonlyArray<ActivityEntry>
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: ActivityFeedConfig<Message>): Html =>
  h.ol(
    [
      h.AriaLabel(config.label),
      h.DataAttribute("slot", "activity-feed"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.list, config.style),
    ],
    config.entries.map((entry, index) =>
      h.keyed("li")(
        entry.key,
        [...styleAttributes(h, styles.entry)],
        [
          h.span(
            [...styleAttributes(h, styles.marker)],
            [
              statusDot(h, entry.tone),
              index === config.entries.length - 1
                ? h.empty
                : h.span([h.AriaHidden(true), ...styleAttributes(h, styles.rail)], []),
            ],
          ),
          h.div(
            [...styleAttributes(h, styles.copy)],
            [
              h.span([...styleAttributes(h, styles.title)], [...entry.title]),
              entry.detail === undefined
                ? h.empty
                : h.span([...styleAttributes(h, styles.detail)], [entry.detail]),
            ],
          ),
          h.time(
            [
              ...(entry.datetime === undefined ? [] : [h.Datetime(entry.datetime)]),
              ...styleAttributes(h, styles.time),
            ],
            [entry.time],
          ),
        ],
      ),
    ),
  )

/** An activity feed. */
export const activityFeed: {
  <Message>(h: HtmlBuilder<Message>, config: ActivityFeedConfig<Message>): Html
  <Message>(config: ActivityFeedConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
