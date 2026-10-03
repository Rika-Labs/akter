import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { type DiagramLayout, lifecycleLayout } from "../geometry/lifecycle.ts"
import { colors, conditions, typography } from "../tokens.stylex.ts"
import { chartStyles } from "./styles.ts"

const styles = stylex.create({
  root: { margin: 0, minWidth: 0, color: colors.foreground },
  wide: {
    display: { default: "block", [conditions.narrow]: "none" },
    width: "100%",
    height: "auto",
  },
  tall: {
    display: { default: "none", [conditions.narrow]: "block" },
    width: "100%",
    maxWidth: "26rem",
    height: "auto",
    marginInline: "auto",
  },
  region: {
    fill: colors.chartFill,
    stroke: colors.borderStrong,
    strokeWidth: 1,
    strokeDasharray: "3 4",
  },
  regionLabel: { fill: colors.mutedForeground, fontSize: "11px", fontFamily: typography.sans },
  edge: { fill: "none", stroke: colors.chartSecondary, strokeWidth: 1.25 },
  edgeAfter: { strokeDasharray: "4 4" },
  arrow: { fill: colors.chartSecondary },
  box: { fill: colors.card, stroke: colors.borderStrong, strokeWidth: 1 },
  emphasis: { stroke: colors.foreground, strokeWidth: 1.5 },
  label: {
    fill: colors.foreground,
    fontSize: "13px",
    fontWeight: typography.weightStrong,
    fontFamily: typography.sans,
  },
  detail: { fill: colors.mutedForeground, fontSize: "11px", fontFamily: typography.sans },
  pulse: {
    fill: colors.foreground,
    display: { default: "inline", [conditions.reducedMotion]: "none" },
  },
})

/** The actor turn lifecycle diagram, accessible as an ordered list of its stages. */
export type LifecycleConfig<Message> = SlotConfig<Message> &
  Readonly<{
    id: string
    animated?: boolean
  }>

const drawing = <Message>(
  h: HtmlBuilder<Message>,
  input: Readonly<{ id: string; layout: DiagramLayout; animated: boolean; wide: boolean }>,
): Html => {
  const { layout } = input
  const arrow = `${input.id}-${input.wide ? "wide" : "tall"}-arrow`
  return h.svg(
    [
      h.ViewBox(`0 0 ${layout.width} ${layout.height}`),
      h.AriaHidden(true),
      ...styleAttributes(h, input.wide ? styles.wide : styles.tall),
    ],
    [
      h.defs(
        [],
        [
          h.marker(
            [
              h.Id(arrow),
              h.Attribute("viewBox", "0 0 8 8"),
              h.Attribute("refX", "7"),
              h.Attribute("refY", "4"),
              h.Attribute("markerWidth", "8"),
              h.Attribute("markerHeight", "8"),
              h.Attribute("markerUnits", "userSpaceOnUse"),
              h.Attribute("orient", "auto"),
            ],
            [h.path([h.D("M1 1L7 4L1 7Z"), ...styleAttributes(h, styles.arrow)], [])],
          ),
        ],
      ),
      ...layout.regions.flatMap((region) => [
        h.rect(
          [
            h.X(String(region.x)),
            h.Y(String(region.y)),
            h.Width(String(region.width)),
            h.Height(String(region.height)),
            h.Rx("10"),
            ...styleAttributes(h, styles.region),
          ],
          [],
        ),
        h.text(
          [
            h.X(String(region.x + 12)),
            h.Y(String(region.y + 17)),
            ...styleAttributes(h, styles.regionLabel),
          ],
          [region.label],
        ),
      ]),
      ...layout.edges.map((edge) =>
        h.path(
          [
            h.D(edge.d),
            h.Attribute("marker-end", `url(#${arrow})`),
            ...styleAttributes(h, styles.edge, edge.dashed && styles.edgeAfter),
          ],
          [],
        ),
      ),
      ...(input.animated
        ? layout.tracks.map((track, index) =>
            h.circle(
              [
                h.R("3.5"),
                h.Opacity(index === 0 ? "0.9" : "0.6"),
                ...styleAttributes(h, styles.pulse),
              ],
              [
                h.animateMotion(
                  [
                    h.Attribute("dur", index === 0 ? "4.8s" : "3.6s"),
                    h.Attribute("begin", "0s"),
                    h.Attribute("repeatCount", "indefinite"),
                    h.Attribute("keyPoints", "0;1;1"),
                    h.Attribute("keyTimes", "0;0.7;1"),
                    h.Attribute("calcMode", "linear"),
                    h.Attribute("path", track),
                  ],
                  [],
                ),
              ],
            ),
          )
        : []),
      ...layout.nodes.map((node) =>
        h.g(
          [h.DataAttribute("stage", node.id)],
          [
            h.rect(
              [
                h.X(String(node.x)),
                h.Y(String(node.y)),
                h.Width(String(node.width)),
                h.Height(String(node.height)),
                h.Rx("6"),
                ...styleAttributes(h, styles.box, node.emphasis && styles.emphasis),
              ],
              [],
            ),
            h.text(
              [
                h.X(String(node.x + node.width / 2)),
                h.Y(String(node.y + node.height / 2 - 3)),
                h.TextAnchor("middle"),
                ...styleAttributes(h, styles.label),
              ],
              [node.label],
            ),
            h.text(
              [
                h.X(String(node.x + node.width / 2)),
                h.Y(String(node.y + node.height / 2 + 13)),
                h.TextAnchor("middle"),
                ...styleAttributes(h, styles.detail),
              ],
              [node.detail],
            ),
          ],
        ),
      ),
    ],
  )
}

const render = <Message>(h: HtmlBuilder<Message>, config: LifecycleConfig<Message>): Html => {
  const animated = config.animated !== false
  const wide = lifecycleLayout("horizontal")
  return h.figure(
    [
      h.DataAttribute("slot", "lifecycle"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.root, config.style),
    ],
    [
      h.figcaption(
        [...styleAttributes(h, chartStyles.summary)],
        [
          "An actor turn: ",
          h.ol(
            [],
            wide.nodes.map((node) => h.li([], [`${node.label}, ${node.detail}`])),
          ),
        ],
      ),
      drawing(h, { id: config.id, layout: wide, animated, wide: true }),
      drawing(h, { id: config.id, layout: lifecycleLayout("vertical"), animated, wide: false }),
    ],
  )
}

/**
 * The actor turn lifecycle: command, fence, receipt, handler, commit and reply, with the outbox
 * releasing jobs, timers and messages after the commit. A marker travels the turn unless the
 * reader prefers reduced motion.
 */
export const lifecycleDiagram: {
  <Message>(h: HtmlBuilder<Message>, config: LifecycleConfig<Message>): Html
  <Message>(config: LifecycleConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
