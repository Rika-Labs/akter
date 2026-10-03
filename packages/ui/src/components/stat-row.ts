import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { sparkline } from "../charts/sparkline.ts"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { borders, colors, conditions, space, typography } from "../tokens.stylex.ts"

const styles = stylex.create({
  row: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(auto-fit, minmax(10rem, 1fr))",
      [conditions.compact]: "repeat(2, minmax(0, 1fr))",
    },
    borderBlockWidth: borders.hairline,
    borderBlockStyle: "solid",
    borderBlockColor: colors.border,
  },
  stat: {
    display: "grid",
    alignContent: "start",
    gap: space.s,
    minWidth: 0,
    paddingBlock: "1.125rem 1rem",
    paddingInline: { default: "1.25rem", [conditions.compact]: space.md },
    borderInlineStartWidth: { default: borders.hairline, ":first-child": 0 },
    borderInlineStartStyle: "solid",
    borderInlineStartColor: colors.border,
    borderBlockEndWidth: { default: 0, [conditions.compact]: borders.hairline },
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
  },
  label: { color: colors.mutedForeground, fontSize: "0.78125rem" },
  value: {
    display: "flex",
    alignItems: "baseline",
    gap: space.xs,
    fontSize: { default: typography.stat, [conditions.compact]: "1.375rem" },
    fontWeight: 500,
    letterSpacing: "-0.6px",
    lineHeight: 1.1,
    fontVariantNumeric: "tabular-nums",
  },
  unit: { color: colors.mutedForeground, fontSize: typography.small, letterSpacing: 0 },
  detail: { color: colors.subtleForeground, fontSize: typography.caption },
  trend: { marginBlockStart: space.xs },
})

/** One headline number with its label, an optional unit and note, and an optional trend. */
export interface Stat {
  readonly label: string
  readonly value: string
  readonly unit?: string
  readonly detail?: string
  readonly trend?: ReadonlyArray<number>
  readonly trendVariant?: "primary" | "muted" | "step"
}

/** A row of headline numbers divided by hairlines, each with a sparkline of its recent trend. */
export type StatRowConfig<Message> = SlotConfig<Message> &
  Readonly<{
    label: string
    stats: ReadonlyArray<Stat>
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: StatRowConfig<Message>): Html =>
  h.dl(
    [
      h.AriaLabel(config.label),
      h.DataAttribute("slot", "stat-row"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.row, config.style),
    ],
    config.stats.map((stat) =>
      h.div(
        [...styleAttributes(h, styles.stat)],
        [
          h.dt([...styleAttributes(h, styles.label)], [stat.label]),
          h.dd(
            [...styleAttributes(h, styles.value)],
            [
              stat.value,
              stat.unit === undefined
                ? h.empty
                : h.span([...styleAttributes(h, styles.unit)], [stat.unit]),
            ],
          ),
          stat.detail === undefined
            ? h.empty
            : h.dd([...styleAttributes(h, styles.detail)], [stat.detail]),
          stat.trend === undefined
            ? h.empty
            : h.dd(
                [...styleAttributes(h, styles.trend)],
                [
                  sparkline(h, {
                    values: stat.trend,
                    height: 28,
                    variant: stat.trendVariant ?? "primary",
                  }),
                ],
              ),
        ],
      ),
    ),
  )

/** A stat row. */
export const statRow: {
  <Message>(h: HtmlBuilder<Message>, config: StatRowConfig<Message>): Html
  <Message>(config: StatRowConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
