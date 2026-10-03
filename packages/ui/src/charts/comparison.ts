import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { borders, colors, conditions, radius, space, typography } from "../tokens.stylex.ts"
import { chartStyles, percent, placement } from "./styles.ts"

const styles = stylex.create({
  root: { display: "grid", gap: space.s, minWidth: 0 },
  row: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(6rem, 9rem) minmax(0, 1fr) 6.5rem",
      [conditions.compact]: "6.5rem minmax(0, 1fr) 5.5rem",
    },
    alignItems: "center",
    gap: space.md,
    minHeight: "1.125rem",
    fontSize: typography.small,
  },
  name: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  strong: { fontWeight: typography.weightStrong },
  absent: { color: colors.subtleForeground },
  track: { position: "relative", height: "0.375rem" },
  bar: {
    position: "absolute",
    insetBlock: 0,
    insetInlineStart: 0,
    minWidth: "3px",
    borderRadius: radius.full,
    backgroundColor: colors.chartMuted,
  },
  barStrong: { backgroundColor: colors.chartLine },
  dashed: {
    position: "absolute",
    insetInline: 0,
    insetBlockStart: "50%",
    borderBlockStartWidth: borders.hairline,
    borderBlockStartStyle: "dashed",
    borderBlockStartColor: colors.borderStrong,
  },
  value: {
    fontFamily: typography.mono,
    fontSize: typography.caption,
    fontVariantNumeric: "tabular-nums",
    textAlign: "end",
    whiteSpace: "nowrap",
  },
  foot: {
    display: "flex",
    justifyContent: "space-between",
    gap: space.md,
    flexWrap: "wrap",
    marginBlockStart: space.sm,
    paddingBlockStart: space.md,
    borderBlockStartWidth: borders.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
    color: colors.mutedForeground,
    fontFamily: typography.mono,
    fontSize: typography.micro,
  },
})

/** One system's result; an absent value is drawn as "not collected", never as zero. */
export interface ComparisonEntry {
  readonly name: string
  readonly value?: number
  readonly highlight?: boolean
  readonly note?: string
}

/**
 * The benchmark comparison: one row per system, the highlighted system in ink and the rest in a
 * quiet grey, bars scaled to the largest value, and values written out in mono with their unit.
 */
export type ComparisonConfig<Message> = SlotConfig<Message> &
  Readonly<{
    label: string
    entries: ReadonlyArray<ComparisonEntry>
    format: (value: number) => string
    footnote?: Readonly<{ label: string; value: string }>
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: ComparisonConfig<Message>): Html => {
  const max = Math.max(...config.entries.map((entry) => entry.value ?? 0), Number.MIN_VALUE)
  return h.div(
    [
      h.Role("list"),
      h.AriaLabel(config.label),
      h.DataAttribute("slot", "comparison"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.root, config.style),
    ],
    [
      ...config.entries.map((entry, index) =>
        h.div(
          [h.Role("listitem"), ...styleAttributes(h, styles.row)],
          [
            h.span(
              [
                ...styleAttributes(
                  h,
                  styles.name,
                  entry.highlight === true && styles.strong,
                  entry.value === undefined && styles.absent,
                ),
              ],
              [entry.name],
            ),
            h.span(
              [h.AriaHidden(true), ...styleAttributes(h, styles.track)],
              [
                entry.value === undefined
                  ? h.span([...styleAttributes(h, styles.dashed)], [])
                  : h.span(
                      [
                        ...styleAttributes(
                          h,
                          styles.bar,
                          chartStyles.drawIn,
                          entry.highlight === true && styles.barStrong,
                          placement.width(percent(entry.value / max)),
                          placement.delay(`${index * 70}ms`),
                        ),
                      ],
                      [],
                    ),
              ],
            ),
            h.span(
              [...styleAttributes(h, styles.value, entry.value === undefined && styles.absent)],
              [
                entry.value === undefined
                  ? "not collected"
                  : `${config.format(entry.value)}${entry.note === undefined ? "" : ` ${entry.note}`}`,
              ],
            ),
          ],
        ),
      ),
      config.footnote === undefined
        ? h.empty
        : h.div(
            [...styleAttributes(h, styles.foot)],
            [h.span([], [config.footnote.label]), h.span([], [config.footnote.value])],
          ),
    ],
  )
}

/** A benchmark comparison. */
export const comparison: {
  <Message>(h: HtmlBuilder<Message>, config: ComparisonConfig<Message>): Html
  <Message>(config: ComparisonConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
