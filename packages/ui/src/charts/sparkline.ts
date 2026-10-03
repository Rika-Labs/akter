import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { areaPath, linePath } from "../geometry/path.ts"
import { extent, linearScale } from "../geometry/scale.ts"
import { borders, colors, radius } from "../tokens.stylex.ts"
import { chartStyles, percent, placement } from "./styles.ts"

const styles = stylex.create({
  root: { position: "relative", display: "block", width: "100%" },
  wash: { fill: colors.chartFill, stroke: "none" },
  end: {
    position: "absolute",
    insetInlineStart: "100%",
    width: "0.3125rem",
    height: "0.3125rem",
    translate: "-50% -50%",
    borderRadius: radius.full,
    backgroundColor: colors.chartLine,
    boxShadow: `0 0 0 ${borders.strong} ${colors.background}`,
  },
})

/** A tiny trend line for a stat: no axes, scaled to its own range, ending in a dot. */
export type SparklineConfig<Message> = SlotConfig<Message> &
  Readonly<{
    values: ReadonlyArray<number>
    height?: number
    variant?: "primary" | "muted" | "step"
    area?: boolean
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: SparklineConfig<Message>): Html => {
  const height = config.height ?? 30
  const width = 200
  const [low, high] = extent(config.values)
  const pad = high === low ? 1 : (high - low) * 0.12
  const y = linearScale({ domain: [low - pad, high + pad], range: [height, 0] })
  const x = linearScale({ domain: [0, Math.max(1, config.values.length - 1)], range: [0, width] })
  const points = config.values.map((value, index) => ({ x: x.map(index), y: y.map(value) }))
  const curve = config.variant === "step" ? "step" : "monotone"
  const last = config.values.at(-1) ?? 0
  return h.span(
    [
      h.AriaHidden(true),
      h.DataAttribute("slot", "sparkline"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.root, placement.height(`${height}px`), config.style),
    ],
    [
      h.svg(
        [
          h.ViewBox(`0 0 ${width} ${height}`),
          h.Attribute("preserveAspectRatio", "none"),
          ...styleAttributes(h, chartStyles.svg, chartStyles.drawIn),
        ],
        [
          config.area === true
            ? h.path(
                [
                  h.D(areaPath({ points, curve, baseline: height })),
                  ...styleAttributes(h, styles.wash),
                ],
                [],
              )
            : h.empty,
          h.path(
            [
              h.D(linePath({ points, curve })),
              ...styleAttributes(
                h,
                config.variant === "muted" ? chartStyles.lineMuted : chartStyles.linePrimary,
              ),
            ],
            [],
          ),
        ],
      ),
      h.span(
        [
          ...styleAttributes(
            h,
            styles.end,
            placement.top(percent(1 - (last - (low - pad)) / (high - low + 2 * pad))),
          ),
        ],
        [],
      ),
    ],
  )
}

/** A sparkline. */
export const sparkline: {
  <Message>(h: HtmlBuilder<Message>, config: SparklineConfig<Message>): Html
  <Message>(config: SparklineConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
