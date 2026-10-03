import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { formatCompact } from "../geometry/format.ts"
import { labelIndices, niceTicks } from "../geometry/ticks.ts"
import { revealMarker } from "../markers.stylex.ts"
import { colors, radius, space, typography } from "../tokens.stylex.ts"
import { chartStyles, percent, placement } from "./styles.ts"

const styles = stylex.create({
  bars: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "stretch",
    gap: "2px",
  },
  slot: {
    position: "relative",
    flex: "1",
    minWidth: 0,
    display: "flex",
    alignItems: "flex-end",
  },
  bar: {
    width: "100%",
    minHeight: "1px",
    borderStartStartRadius: "2px",
    borderStartEndRadius: "2px",
    backgroundColor: {
      default: colors.chartMuted,
      [stylex.when.ancestor(":hover", revealMarker)]: colors.chartSecondary,
    },
    transitionProperty: "background-color",
    transitionDuration: "120ms",
  },
  highlight: {
    backgroundColor: {
      default: colors.chartLine,
      [stylex.when.ancestor(":hover", revealMarker)]: colors.chartLine,
    },
  },
  gridLine: {
    position: "absolute",
    insetInline: 0,
    height: "1px",
    backgroundColor: colors.chartGrid,
  },
  baseline: { backgroundColor: colors.chartMuted },
  readout: {
    insetBlockStart: "auto",
    insetBlockEnd: "calc(100% + 0.5rem)",
    insetInlineStart: "50%",
    translate: "-50% 0",
  },
  horizontal: { display: "grid", gap: space.s, minWidth: 0 },
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(5rem, 9rem) minmax(0, 1fr) auto",
    alignItems: "center",
    gap: space.md,
    fontSize: typography.small,
  },
  name: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  track: {
    position: "relative",
    height: "0.5rem",
    borderRadius: radius.full,
    backgroundColor: colors.chartGrid,
  },
  fill: {
    position: "absolute",
    insetBlock: 0,
    insetInlineStart: 0,
    borderRadius: radius.full,
    backgroundColor: colors.chartMuted,
  },
  fillHighlight: { backgroundColor: colors.chartLine },
  value: {
    fontFamily: typography.mono,
    fontSize: typography.caption,
    fontVariantNumeric: "tabular-nums",
    color: colors.mutedForeground,
    textAlign: "end",
  },
})

/** One bar: its category, value, and whether it is the bar to look at. */
export interface BarDatum {
  readonly key: string
  readonly label: string
  readonly value: number
  readonly highlight?: boolean
}

/**
 * Bars over categories. `vertical` suits time buckets (jobs per minute, commands per day) and
 * reveals each value on hover; `horizontal` suits ranked categories with the values written out.
 */
export type BarChartConfig<Message> = SlotConfig<Message> &
  Readonly<{
    label: string
    data: ReadonlyArray<BarDatum>
    orientation?: "vertical" | "horizontal"
    height?: number
    formatValue?: (value: number) => string
    xTicks?: number
    yTicks?: number
  }>

const vertical = <Message>(h: HtmlBuilder<Message>, config: BarChartConfig<Message>): Html => {
  const height = config.height ?? 160
  const format = config.formatValue ?? formatCompact
  const axis = niceTicks({
    min: 0,
    max: Math.max(1, ...config.data.map((datum) => datum.value)),
    count: config.yTicks ?? 4,
  })
  const top = (value: number) => 1 - value / axis.max
  const gutter = `${Math.max(...axis.ticks.map((tick) => format(tick).length)) * 0.42 + 0.75}rem`
  const labels = labelIndices({ length: config.data.length, count: config.xTicks ?? 6 })
  const center = (index: number) => (index + 0.5) / Math.max(1, config.data.length)
  return h.figure(
    [
      h.DataAttribute("slot", "bar-chart"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, chartStyles.figure, config.style),
    ],
    [
      h.figcaption(
        [...styleAttributes(h, chartStyles.summary)],
        [
          `${config.label}. ${config.data.map((datum) => `${datum.label}: ${format(datum.value)}`).join(", ")}.`,
        ],
      ),
      h.div(
        [
          h.AriaHidden(true),
          ...styleAttributes(
            h,
            chartStyles.plot,
            placement.height(`${height}px`),
            placement.gutter(gutter),
          ),
        ],
        [
          ...axis.ticks.map((tick) =>
            h.span(
              [
                ...styleAttributes(
                  h,
                  styles.gridLine,
                  tick === 0 && styles.baseline,
                  placement.top(percent(top(tick))),
                ),
              ],
              [],
            ),
          ),
          ...axis.ticks.map((tick) =>
            h.span(
              [...styleAttributes(h, chartStyles.axisY, placement.top(percent(top(tick))))],
              [format(tick)],
            ),
          ),
          h.div(
            [...styleAttributes(h, styles.bars)],
            config.data.map((datum, index) =>
              h.keyed("div")(
                datum.key,
                [...styleAttributes(h, styles.slot, revealMarker)],
                [
                  h.div(
                    [
                      ...styleAttributes(
                        h,
                        styles.bar,
                        chartStyles.growIn,
                        datum.highlight === true && styles.highlight,
                        placement.height(percent(datum.value / axis.max)),
                        placement.delay(`${Math.min(index * 12, 400)}ms`),
                      ),
                    ],
                    [],
                  ),
                  h.div(
                    [...styleAttributes(h, chartStyles.readout, styles.readout)],
                    [
                      h.span([...styleAttributes(h, chartStyles.readoutTitle)], [datum.label]),
                      h.span(
                        [...styleAttributes(h, chartStyles.readoutValue)],
                        [format(datum.value)],
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
      h.div(
        [h.AriaHidden(true), ...styleAttributes(h, chartStyles.axisX, placement.gutter(gutter))],
        labels.map((index) =>
          h.span(
            [...styleAttributes(h, chartStyles.tickX, placement.left(percent(center(index))))],
            [config.data[index]?.label ?? ""],
          ),
        ),
      ),
    ],
  )
}

const horizontal = <Message>(h: HtmlBuilder<Message>, config: BarChartConfig<Message>): Html => {
  const format = config.formatValue ?? formatCompact
  const max = Math.max(1, ...config.data.map((datum) => datum.value))
  return h.div(
    [
      h.Role("list"),
      h.AriaLabel(config.label),
      h.DataAttribute("slot", "bar-chart"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.horizontal, config.style),
    ],
    config.data.map((datum, index) =>
      h.keyed("div")(
        datum.key,
        [h.Role("listitem"), ...styleAttributes(h, styles.row)],
        [
          h.span([...styleAttributes(h, styles.name)], [datum.label]),
          h.span(
            [h.AriaHidden(true), ...styleAttributes(h, styles.track)],
            [
              h.span(
                [
                  ...styleAttributes(
                    h,
                    styles.fill,
                    chartStyles.drawIn,
                    datum.highlight === true && styles.fillHighlight,
                    placement.width(percent(datum.value / max)),
                    placement.delay(`${index * 60}ms`),
                  ),
                ],
                [],
              ),
            ],
          ),
          h.span([...styleAttributes(h, styles.value)], [format(datum.value)]),
        ],
      ),
    ),
  )
}

/** A vertical or horizontal bar chart. */
export const barChart: {
  <Message>(h: HtmlBuilder<Message>, config: BarChartConfig<Message>): Html
  <Message>(config: BarChartConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, <Message>(h: HtmlBuilder<Message>, config: BarChartConfig<Message>): Html =>
  config.orientation === "horizontal" ? horizontal(h, config) : vertical(h, config),
)
