import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { formatCompact } from "../geometry/format.ts"
import { type Bucket, bucketQuantile } from "../geometry/histogram.ts"
import { labelIndices } from "../geometry/ticks.ts"
import { revealMarker } from "../markers.stylex.ts"
import { colors, space, typography } from "../tokens.stylex.ts"
import { chartStyles, percent, placement } from "./styles.ts"

const styles = stylex.create({
  bars: { position: "absolute", inset: 0, display: "flex", alignItems: "stretch", gap: "1px" },
  slot: { position: "relative", flex: "1", display: "flex", alignItems: "flex-end", minWidth: 0 },
  bar: {
    width: "100%",
    minHeight: "1px",
    backgroundColor: {
      default: colors.chartMuted,
      [stylex.when.ancestor(":hover", revealMarker)]: colors.chartSecondary,
    },
  },
  tail: { backgroundColor: colors.chartSecondary },
  readout: {
    insetBlockStart: "auto",
    insetBlockEnd: "calc(100% + 0.5rem)",
    insetInlineStart: "50%",
    translate: "-50% 0",
  },
  quantile: {
    position: "absolute",
    insetBlock: "-1.25rem 0",
    width: 0,
    borderInlineStartWidth: "1px",
    borderInlineStartStyle: "dashed",
    borderInlineStartColor: colors.chartLine,
  },
  quantileLabel: {
    position: "absolute",
    insetBlockStart: 0,
    insetInlineStart: space.xs,
    color: colors.foreground,
    fontSize: typography.micro,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    lineHeight: 1,
  },
  baseline: {
    position: "absolute",
    insetInline: 0,
    insetBlockEnd: 0,
    height: "1px",
    backgroundColor: colors.chartMuted,
  },
  headroom: { paddingBlockStart: "1.5rem" },
})

/**
 * A latency distribution over log-spaced buckets, with dashed markers at the requested quantiles
 * (interpolated inside their bucket) and the bars beyond the last quantile drawn darker as the tail.
 */
export type HistogramConfig<Message> = SlotConfig<Message> &
  Readonly<{
    label: string
    buckets: ReadonlyArray<Bucket>
    quantiles: ReadonlyArray<Readonly<{ label: string; quantile: number }>>
    formatBound: (value: number) => string
    height?: number
  }>

const position = (buckets: ReadonlyArray<Bucket>, value: number): number => {
  let lower = 0
  for (const [index, bucket] of buckets.entries()) {
    if (value <= bucket.upper)
      return (
        (index + (value - lower) / Math.max(bucket.upper - lower, Number.EPSILON)) / buckets.length
      )
    lower = bucket.upper
  }
  return 1
}

const render = <Message>(h: HtmlBuilder<Message>, config: HistogramConfig<Message>): Html => {
  const height = config.height ?? 140
  const peak = Math.max(1, ...config.buckets.map((bucket) => bucket.count))
  const marks = config.quantiles.map((entry) => {
    const value = bucketQuantile({ buckets: config.buckets, quantile: entry.quantile })
    return { label: entry.label, value, at: position(config.buckets, value) }
  })
  const tailFrom = marks.at(-1)?.at ?? 1
  const labels = labelIndices({ length: config.buckets.length, count: 6 })
  return h.figure(
    [
      h.DataAttribute("slot", "histogram"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, chartStyles.figure, config.style),
    ],
    [
      h.figcaption(
        [...styleAttributes(h, chartStyles.summary)],
        [
          `${config.label}. ${marks.map((mark) => `${mark.label} ${config.formatBound(mark.value)}`).join(", ")}.`,
        ],
      ),
      h.div(
        [h.AriaHidden(true), ...styleAttributes(h, styles.headroom)],
        [
          h.div(
            [...styleAttributes(h, chartStyles.plot, placement.height(`${height}px`))],
            [
              h.div(
                [...styleAttributes(h, styles.bars)],
                config.buckets.map((bucket, index) =>
                  h.div(
                    [...styleAttributes(h, styles.slot, revealMarker)],
                    [
                      h.div(
                        [
                          ...styleAttributes(
                            h,
                            styles.bar,
                            chartStyles.growIn,
                            (index + 1) / config.buckets.length > tailFrom && styles.tail,
                            placement.height(percent(bucket.count / peak)),
                            placement.delay(`${index * 18}ms`),
                          ),
                        ],
                        [],
                      ),
                      h.div(
                        [...styleAttributes(h, chartStyles.readout, styles.readout)],
                        [
                          h.span(
                            [...styleAttributes(h, chartStyles.readoutTitle)],
                            [`≤ ${config.formatBound(bucket.upper)}`],
                          ),
                          h.span(
                            [...styleAttributes(h, chartStyles.readoutValue)],
                            [formatCompact(bucket.count)],
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
              h.span([...styleAttributes(h, styles.baseline)], []),
              ...marks.map((mark) =>
                h.span(
                  [...styleAttributes(h, styles.quantile, placement.left(percent(mark.at)))],
                  [
                    h.span(
                      [...styleAttributes(h, styles.quantileLabel)],
                      [`${mark.label} ${config.formatBound(mark.value)}`],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
      h.div(
        [h.AriaHidden(true), ...styleAttributes(h, chartStyles.axisX)],
        labels.map((index, slot) =>
          h.span(
            [
              ...styleAttributes(
                h,
                chartStyles.tickX,
                slot === 0 && chartStyles.tickFirst,
                slot === labels.length - 1 && chartStyles.tickLast,
                placement.left(percent((index + 1) / config.buckets.length)),
              ),
            ],
            [config.formatBound(config.buckets[index]?.upper ?? 0)],
          ),
        ),
      ),
    ],
  )
}

/** A latency histogram. */
export const histogram: {
  <Message>(h: HtmlBuilder<Message>, config: HistogramConfig<Message>): Html
  <Message>(config: HistogramConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
