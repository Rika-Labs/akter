import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { formatCompact } from "../geometry/format.ts"
import { areaPath, type Curve, linePath } from "../geometry/path.ts"
import { linearScale } from "../geometry/scale.ts"
import { labelIndices, niceTicks } from "../geometry/ticks.ts"
import { revealMarker } from "../markers.stylex.ts"
import { colors, typography } from "../tokens.stylex.ts"
import { chartStyles as styles, percent, placement } from "./styles.ts"

/** How a series is drawn: the solid ink line, a dashed companion, or a quiet reference. */
export type SeriesVariant = "primary" | "secondary" | "muted"

/** One line on the chart. `area` fills beneath it with a fading wash. */
export interface ChartSeries {
  readonly id: string
  readonly label: string
  readonly values: ReadonlyArray<number>
  readonly variant: SeriesVariant
  readonly area?: boolean
  readonly format?: (value: number) => string
}

/** An event to mark on the time axis, such as a deploy. */
export interface ChartMarker {
  readonly index: number
  readonly label: string
}

const local = stylex.create({
  gradientStop: { stopColor: colors.chartLine },
  markerLabel: {
    position: "absolute",
    insetBlockStart: 0,
    marginInlineStart: "0.375rem",
    color: colors.subtleForeground,
    fontFamily: typography.mono,
    fontSize: "0.65625rem",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  },
})

const lineStyles = {
  primary: styles.linePrimary,
  secondary: styles.lineSecondary,
  muted: styles.lineMuted,
} as const

const swatchStyles = {
  primary: styles.swatchPrimary,
  secondary: styles.swatchSecondary,
  muted: styles.swatchMuted,
} as const

/**
 * A multi-series line or area chart: hairline grid, round y ticks, sparse x labels, and a hover
 * crosshair with a readout of every series at that point. `categories` labels each point.
 */
export type LineChartConfig<Message> = SlotConfig<Message> &
  Readonly<{
    id: string
    label: string
    series: ReadonlyArray<ChartSeries>
    categories: ReadonlyArray<string>
    height?: number
    curve?: Curve
    formatValue?: (value: number) => string
    xTicks?: number
    yTicks?: number
    markers?: ReadonlyArray<ChartMarker>
    legend?: boolean
  }>

const viewWidth = 1000

const render = <Message>(h: HtmlBuilder<Message>, config: LineChartConfig<Message>): Html => {
  const height = config.height ?? 200
  const format = config.formatValue ?? formatCompact
  const count = Math.max(...config.series.map((series) => series.values.length), 1)
  const all = config.series.flatMap((series) => series.values)
  const axis = niceTicks({
    min: Math.min(0, ...all),
    max: Math.max(...all, 1),
    count: config.yTicks ?? 4,
  })
  const x = linearScale({ domain: [0, count - 1], range: [0, viewWidth] })
  const y = linearScale({ domain: [axis.min, axis.max], range: [height, 0] })
  const fraction = (index: number) => (count === 1 ? 0.5 : index / (count - 1))
  const top = (value: number) => 1 - (value - axis.min) / (axis.max - axis.min)
  const gutter = `${Math.max(...axis.ticks.map((tick) => format(tick).length)) * 0.42 + 0.75}rem`
  const step = count === 1 ? 1 : 1 / (count - 1)
  const summary = config.series
    .map((series) => {
      const last = series.values.at(-1) ?? 0
      return `${series.label}: from ${format(series.values[0] ?? 0)} to ${format(last)}, peak ${format(Math.max(...series.values))}`
    })
    .join(". ")
  const showLegend = config.legend ?? config.series.length > 1
  const svg = h.svg(
    [
      h.ViewBox(`0 0 ${viewWidth} ${height}`),
      h.Attribute("preserveAspectRatio", "none"),
      h.AriaHidden(true),
      ...styleAttributes(h, styles.svg),
    ],
    [
      h.defs(
        [],
        config.series.flatMap((series) =>
          series.area !== true
            ? []
            : h.linearGradient(
                [
                  h.Id(`${config.id}-${series.id}-wash`),
                  h.Attribute("x1", "0"),
                  h.Attribute("y1", "0"),
                  h.Attribute("x2", "0"),
                  h.Attribute("y2", "1"),
                ],
                [
                  h.stop(
                    [
                      h.Attribute("offset", "0"),
                      h.Attribute("stop-opacity", "0.11"),
                      ...styleAttributes(h, local.gradientStop),
                    ],
                    [],
                  ),
                  h.stop(
                    [
                      h.Attribute("offset", "1"),
                      h.Attribute("stop-opacity", "0"),
                      ...styleAttributes(h, local.gradientStop),
                    ],
                    [],
                  ),
                ],
              ),
        ),
      ),
      ...axis.ticks.map((tick) =>
        h.line(
          [
            h.X1("0"),
            h.X2(String(viewWidth)),
            h.Y1(y.map(tick).toFixed(2)),
            h.Y2(y.map(tick).toFixed(2)),
            ...styleAttributes(h, tick === axis.min ? styles.baseline : styles.grid),
          ],
          [],
        ),
      ),
      ...(config.markers ?? []).map((marker) =>
        h.line(
          [
            h.X1(x.map(marker.index).toFixed(2)),
            h.X2(x.map(marker.index).toFixed(2)),
            h.Y1("0"),
            h.Y2(String(height)),
            ...styleAttributes(h, styles.marker),
          ],
          [],
        ),
      ),
      h.g(
        [...styleAttributes(h, styles.drawIn)],
        config.series.flatMap((series) => {
          const points = series.values.map((value, index) => ({ x: x.map(index), y: y.map(value) }))
          const curve = config.curve ?? "monotone"
          return [
            series.area === true
              ? h.path(
                  [
                    h.D(areaPath({ points, curve, baseline: y.map(axis.min) })),
                    h.Fill(`url(#${config.id}-${series.id}-wash)`),
                  ],
                  [],
                )
              : h.empty,
            h.path(
              [h.D(linePath({ points, curve })), ...styleAttributes(h, lineStyles[series.variant])],
              [],
            ),
          ]
        }),
      ),
    ],
  )
  const columns = Array.from({ length: count }, (_, index) => {
    const at = fraction(index)
    const flip = at > 0.66
    return h.div(
      [
        h.DataAttribute("point", String(index)),
        ...styleAttributes(
          h,
          styles.column,
          revealMarker,
          placement.span(
            percent(Math.max(0, at - step / 2)),
            percent(Math.min(step, at + step / 2, 1 - at + step / 2)),
          ),
        ),
      ],
      [
        h.span([...styleAttributes(h, styles.crosshair)], []),
        ...config.series.map((series) =>
          h.span(
            [
              ...styleAttributes(
                h,
                styles.dot,
                series.variant !== "primary" && styles.dotSecondary,
                placement.top(percent(top(series.values[index] ?? 0))),
              ),
            ],
            [],
          ),
        ),
        h.div(
          [...styleAttributes(h, styles.readout, flip ? styles.readoutLeft : styles.readoutRight)],
          [
            h.span([...styleAttributes(h, styles.readoutTitle)], [config.categories[index] ?? ""]),
            ...config.series.map((series) =>
              h.span(
                [...styleAttributes(h, styles.readoutRow)],
                [
                  h.span([...styleAttributes(h, styles.swatch, swatchStyles[series.variant])], []),
                  series.label,
                  h.span(
                    [...styleAttributes(h, styles.readoutValue)],
                    [(series.format ?? format)(series.values[index] ?? 0)],
                  ),
                ],
              ),
            ),
          ],
        ),
      ],
    )
  })
  const xLabels = labelIndices({ length: count, count: config.xTicks ?? 6 })
  return h.figure(
    [
      h.DataAttribute("slot", "line-chart"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.figure, config.style),
    ],
    [
      h.figcaption([...styleAttributes(h, styles.summary)], [`${config.label}. ${summary}.`]),
      showLegend
        ? h.div(
            [h.AriaHidden(true), ...styleAttributes(h, styles.legend, placement.gutter(gutter))],
            config.series.map((series) =>
              h.span(
                [...styleAttributes(h, styles.legendItem)],
                [
                  h.span([...styleAttributes(h, styles.swatch, swatchStyles[series.variant])], []),
                  series.label,
                ],
              ),
            ),
          )
        : h.empty,
      h.div(
        [
          h.AriaHidden(true),
          ...styleAttributes(
            h,
            styles.plot,
            placement.height(`${height}px`),
            placement.gutter(gutter),
          ),
        ],
        [
          svg,
          ...axis.ticks.map((tick) =>
            h.span(
              [...styleAttributes(h, styles.axisY, placement.top(percent(top(tick))))],
              [format(tick)],
            ),
          ),
          ...(config.markers ?? []).map((marker) =>
            h.span(
              [
                ...styleAttributes(
                  h,
                  local.markerLabel,
                  placement.left(percent(fraction(marker.index))),
                ),
              ],
              [marker.label],
            ),
          ),
          h.div([...styleAttributes(h, styles.hoverLayer)], columns),
        ],
      ),
      h.div(
        [h.AriaHidden(true), ...styleAttributes(h, styles.axisX, placement.gutter(gutter))],
        xLabels.map((index, position) =>
          h.span(
            [
              ...styleAttributes(
                h,
                styles.tickX,
                position === 0 && styles.tickFirst,
                position === xLabels.length - 1 && styles.tickLast,
                placement.left(percent(fraction(index))),
              ),
            ],
            [config.categories[index] ?? ""],
          ),
        ),
      ),
    ],
  )
}

/** A line or area chart. */
export const lineChart: {
  <Message>(h: HtmlBuilder<Message>, config: LineChartConfig<Message>): Html
  <Message>(config: LineChartConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
