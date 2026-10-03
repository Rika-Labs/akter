import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { formatPercent } from "../geometry/format.ts"
import { colors, radius, space, typography } from "../tokens.stylex.ts"
import { chartStyles, percent, placement } from "./styles.ts"

const styles = stylex.create({
  root: { display: "grid", gap: space.sm, minWidth: 0 },
  head: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.md,
    flexWrap: "wrap",
  },
  label: { fontWeight: typography.weightMedium },
  figures: { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
  of: { color: colors.subtleForeground },
  over: { color: colors.foreground, fontWeight: typography.weightMedium },
  track: {
    position: "relative",
    display: "flex",
    height: "0.375rem",
    borderRadius: radius.full,
    backgroundColor: colors.chartGrid,
    overflow: "hidden",
  },
  used: { height: "100%", backgroundColor: colors.chartLine },
  overage: {
    height: "100%",
    backgroundImage: `repeating-linear-gradient(-45deg, ${colors.chartLine} 0 2px, transparent 2px 4px)`,
  },
  limit: {
    position: "absolute",
    insetBlock: 0,
    width: "2px",
    backgroundColor: colors.background,
  },
  detail: { color: colors.mutedForeground, fontSize: typography.caption },
  stack: { display: "grid", gap: space.sm, minWidth: 0 },
  segment: { height: "100%" },
  ink: { backgroundColor: colors.chartLine },
  secondary: { backgroundColor: colors.chartSecondary },
  muted: { backgroundColor: colors.chartMuted },
  gap: { marginInlineStart: "2px" },
  legend: {
    display: "flex",
    gap: space.lg,
    flexWrap: "wrap",
    color: colors.mutedForeground,
    fontSize: typography.caption,
  },
  legendItem: { display: "inline-flex", alignItems: "center", gap: space.s },
  key: { width: "0.5rem", height: "0.5rem", borderRadius: "2px" },
  legendValue: { color: colors.foreground, fontVariantNumeric: "tabular-nums" },
})

/**
 * Usage against an allowance. Within the allowance the bar fills in ink; past it the track rescales
 * to the usage and the overage is hatched, with a notch where the allowance ends.
 */
export type MeterConfig<Message> = SlotConfig<Message> &
  Readonly<{
    label: string
    value: number
    limit: number
    format: (value: number) => string
    detail?: string
    compact?: boolean
  }>

const renderMeter = <Message>(h: HtmlBuilder<Message>, config: MeterConfig<Message>): Html => {
  const over = config.value > config.limit
  const scale = over ? config.value : config.limit
  const included = Math.min(config.value, config.limit) / scale
  return h.div(
    [
      h.DataAttribute("slot", "meter"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.root, config.style),
    ],
    [
      h.div(
        [...styleAttributes(h, styles.head)],
        [
          config.compact === true
            ? h.empty
            : h.span([...styleAttributes(h, styles.label)], [config.label]),
          h.span(
            [...styleAttributes(h, styles.figures)],
            [
              config.format(config.value),
              h.span([...styleAttributes(h, styles.of)], [` of ${config.format(config.limit)}`]),
              over
                ? h.span(
                    [...styleAttributes(h, styles.over)],
                    [` · ${config.format(config.value - config.limit)} over`],
                  )
                : h.empty,
            ],
          ),
        ],
      ),
      h.div(
        [
          h.Role("meter"),
          h.AriaLabel(config.label),
          h.AriaValuemin(0),
          h.AriaValuemax(config.limit),
          h.AriaValuenow(config.value),
          h.AriaValuetext(
            `${config.format(config.value)} of ${config.format(config.limit)}, ${formatPercent(config.value / config.limit)}`,
          ),
          ...styleAttributes(h, styles.track),
        ],
        [
          h.span(
            [
              ...styleAttributes(
                h,
                styles.used,
                chartStyles.drawIn,
                placement.width(percent(included)),
              ),
            ],
            [],
          ),
          over
            ? h.span(
                [...styleAttributes(h, styles.overage, placement.width(percent(1 - included)))],
                [],
              )
            : h.empty,
          over
            ? h.span([...styleAttributes(h, styles.limit, placement.left(percent(included)))], [])
            : h.empty,
        ],
      ),
      config.detail === undefined
        ? h.empty
        : h.span([...styleAttributes(h, styles.detail)], [config.detail]),
    ],
  )
}

/** A usage meter. */
export const meter: {
  <Message>(h: HtmlBuilder<Message>, config: MeterConfig<Message>): Html
  <Message>(config: MeterConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, renderMeter)

/** One part of a whole. */
export interface StackSegment {
  readonly label: string
  readonly value: number
  readonly tone: "ink" | "secondary" | "muted"
}

/** Parts of a whole in one bar with a legend, such as open sockets by state. */
export type StackedBarConfig<Message> = SlotConfig<Message> &
  Readonly<{
    label: string
    segments: ReadonlyArray<StackSegment>
    format: (value: number) => string
  }>

const renderStacked = <Message>(
  h: HtmlBuilder<Message>,
  config: StackedBarConfig<Message>,
): Html => {
  const total = Math.max(
    1,
    config.segments.reduce((sum, segment) => sum + segment.value, 0),
  )
  return h.div(
    [
      h.DataAttribute("slot", "stacked-bar"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.stack, config.style),
    ],
    [
      h.div(
        [
          h.Role("img"),
          h.AriaLabel(
            `${config.label}: ${config.segments.map((segment) => `${segment.label} ${config.format(segment.value)}`).join(", ")}`,
          ),
          ...styleAttributes(h, styles.track),
        ],
        config.segments.map((segment, index) =>
          h.span(
            [
              ...styleAttributes(
                h,
                styles.segment,
                chartStyles.drawIn,
                styles[segment.tone],
                index > 0 && styles.gap,
                placement.width(percent(segment.value / total)),
              ),
            ],
            [],
          ),
        ),
      ),
      h.div(
        [h.AriaHidden(true), ...styleAttributes(h, styles.legend)],
        config.segments.map((segment) =>
          h.span(
            [...styleAttributes(h, styles.legendItem)],
            [
              h.span([...styleAttributes(h, styles.key, styles[segment.tone])], []),
              segment.label,
              h.span([...styleAttributes(h, styles.legendValue)], [config.format(segment.value)]),
            ],
          ),
        ),
      ),
    ],
  )
}

/** A stacked bar. */
export const stackedBar: {
  <Message>(h: HtmlBuilder<Message>, config: StackedBarConfig<Message>): Html
  <Message>(config: StackedBarConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, renderStacked)
