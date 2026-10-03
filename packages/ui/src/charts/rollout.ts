import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { areaPath, linePath } from "../geometry/path.ts"
import { type RolloutPhase, rolloutLayout } from "../geometry/rollout.ts"
import { borders, colors, conditions, motion, radius, space, typography } from "../tokens.stylex.ts"
import { chartStyles, percent, placement } from "./styles.ts"

const sweep = stylex.keyframes({
  from: { transform: "scaleX(0)" },
  to: { transform: "scaleX(1)" },
})

const styles = stylex.create({
  root: { display: "grid", gap: space.xs, margin: 0, minWidth: 0 },
  row: {
    display: "grid",
    gridTemplateColumns: {
      default: "11rem minmax(0, 1fr) 4.5rem",
      [conditions.narrow]: "7.5rem minmax(0, 1fr) 3.5rem",
    },
    alignItems: "center",
    gap: space.md,
    minHeight: "2.875rem",
  },
  name: { display: "grid", minWidth: 0 },
  label: {
    fontWeight: typography.weightMedium,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  detail: {
    color: colors.mutedForeground,
    fontSize: typography.caption,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  track: { position: "relative", alignSelf: "stretch", minHeight: "2.875rem" },
  rail: {
    position: "absolute",
    insetInline: 0,
    insetBlockStart: "50%",
    height: "1px",
    backgroundColor: colors.chartGrid,
  },
  bar: {
    position: "absolute",
    insetBlockStart: "calc(50% - 0.25rem)",
    height: "0.5rem",
    minWidth: "3px",
    borderRadius: radius.xs,
    backgroundColor: colors.chartLine,
    transformOrigin: "left",
    animationName: { default: sweep, [conditions.reducedMotion]: "none" },
    animationDuration: motion.slow,
    animationTimingFunction: motion.easeOut,
    animationFillMode: "both",
  },
  duration: {
    color: colors.mutedForeground,
    fontSize: typography.caption,
    fontVariantNumeric: "tabular-nums",
    textAlign: "end",
  },
  grid: {
    position: "absolute",
    insetBlock: 0,
    width: "1px",
    backgroundColor: colors.chartGrid,
  },
  live: {
    position: "absolute",
    insetBlock: 0,
    width: 0,
    borderInlineStartWidth: borders.hairline,
    borderInlineStartStyle: "dashed",
    borderInlineStartColor: colors.chartLine,
  },
  shift: { height: "3.5rem" },
  shiftSvg: { position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" },
  wash: { fill: colors.chartFill, stroke: "none" },
  ticks: { position: "relative", height: "1rem" },
  lanes: { position: "relative", display: "grid" },
})

/** A deploy's phases on one time axis, and the window during which actors moved to the new runners. */
export type RolloutConfig<Message> = SlotConfig<Message> &
  Readonly<{
    label: string
    phases: ReadonlyArray<RolloutPhase>
    shift: Readonly<{ start: number; end: number; label: string; detail: string }>
    live: Readonly<{ at: number; label: string }>
    formatSeconds: (seconds: number) => string
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: RolloutConfig<Message>): Html => {
  const layout = rolloutLayout({ phases: config.phases, shift: config.shift })
  const width = 1000
  const height = 56
  const points = layout.share.map((point) => ({
    x: point.x * width,
    y: height - point.y * (height - 6),
  }))
  const previous = layout.share.map((point) => ({
    x: point.x * width,
    y: height - (1 - point.y) * (height - 6),
  }))
  const grid = (key: string) =>
    layout.ticks.map((tick) =>
      h.span(
        [
          h.Key(`${key}-${String(tick.value)}`),
          ...styleAttributes(h, styles.grid, placement.left(percent(tick.position))),
        ],
        [],
      ),
    )
  const liveLine = h.span(
    [
      h.Title(config.live.label),
      ...styleAttributes(h, styles.live, placement.left(percent(config.live.at / layout.span))),
    ],
    [],
  )
  return h.figure(
    [
      h.AriaLabel(config.label),
      h.DataAttribute("slot", "rollout"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.root, config.style),
    ],
    [
      h.ol(
        [h.AriaLabel("Phases"), ...styleAttributes(h, styles.lanes)],
        config.phases.map((phase, index) => {
          const bar = layout.bars[index]
          return h.li(
            [...styleAttributes(h, styles.row)],
            [
              h.span(
                [...styleAttributes(h, styles.name)],
                [
                  h.span([...styleAttributes(h, styles.label)], [phase.label]),
                  h.span([...styleAttributes(h, styles.detail)], [phase.detail]),
                ],
              ),
              h.span(
                [h.AriaHidden(true), ...styleAttributes(h, styles.track)],
                [
                  ...grid(phase.id),
                  h.span([...styleAttributes(h, styles.rail)], []),
                  h.span(
                    [
                      ...styleAttributes(
                        h,
                        styles.bar,
                        placement.span(percent(bar?.left ?? 0), percent(bar?.width ?? 0)),
                        placement.delay(`${index * 140}ms`),
                      ),
                    ],
                    [],
                  ),
                  liveLine,
                ],
              ),
              h.span(
                [...styleAttributes(h, styles.duration)],
                [config.formatSeconds(phase.end - phase.start)],
              ),
            ],
          )
        }),
      ),
      h.div(
        [...styleAttributes(h, styles.row)],
        [
          h.span(
            [...styleAttributes(h, styles.name)],
            [
              h.span([...styleAttributes(h, styles.label)], [config.shift.label]),
              h.span([...styleAttributes(h, styles.detail)], [config.shift.detail]),
            ],
          ),
          h.span(
            [h.AriaHidden(true), ...styleAttributes(h, styles.track, styles.shift)],
            [
              ...grid("shift"),
              h.svg(
                [
                  h.ViewBox(`0 0 ${width} ${height}`),
                  h.Attribute("preserveAspectRatio", "none"),
                  ...styleAttributes(h, styles.shiftSvg, chartStyles.drawIn),
                ],
                [
                  h.path(
                    [
                      h.D(areaPath({ points, curve: "monotone", baseline: height })),
                      ...styleAttributes(h, styles.wash),
                    ],
                    [],
                  ),
                  h.path(
                    [
                      h.D(linePath({ points, curve: "monotone" })),
                      ...styleAttributes(h, chartStyles.linePrimary),
                    ],
                    [],
                  ),
                  h.path(
                    [
                      h.D(linePath({ points: previous, curve: "monotone" })),
                      ...styleAttributes(h, chartStyles.lineSecondary),
                    ],
                    [],
                  ),
                ],
              ),
              liveLine,
            ],
          ),
          h.span(
            [...styleAttributes(h, styles.duration)],
            [config.formatSeconds(config.shift.end - config.shift.start)],
          ),
        ],
      ),
      h.div(
        [h.AriaHidden(true), ...styleAttributes(h, styles.row)],
        [
          h.span([], []),
          h.span(
            [...styleAttributes(h, styles.ticks, chartStyles.axisX)],
            layout.ticks.map((tick, index) =>
              h.span(
                [
                  ...styleAttributes(
                    h,
                    chartStyles.tickX,
                    index === 0 && chartStyles.tickFirst,
                    index === layout.ticks.length - 1 && chartStyles.tickLast,
                    placement.left(percent(tick.position)),
                  ),
                ],
                [config.formatSeconds(tick.value)],
              ),
            ),
          ),
          h.span([], []),
        ],
      ),
    ],
  )
}

/**
 * A deployment rollout timeline: each phase as a bar on a shared seconds axis, the share of turns
 * served by the new version rising while actors move (the dashed line is the previous version
 * draining), and a dashed rule where the deploy went live.
 */
export const rolloutTimeline: {
  <Message>(h: HtmlBuilder<Message>, config: RolloutConfig<Message>): Html
  <Message>(config: RolloutConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
