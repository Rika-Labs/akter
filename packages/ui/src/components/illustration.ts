import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Drawing, Figure, Group, Paint } from "../brand/figure.ts"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { colors, conditions, motion, scene, typography } from "../tokens.stylex.ts"

const glide = stylex.keyframes({ to: { strokeDashoffset: -58 } })

const travel = stylex.keyframes({
  "0%, 15%": { transform: "translateX(0)" },
  "45%, 60%": { transform: `translateX(${scene.reach})` },
  "90%, 100%": { transform: "translateX(0)" },
})

const lift = stylex.keyframes({
  "0%, 5%": { transform: "translateY(0)" },
  "15%, 45%": { transform: `translateY(${scene.lift})` },
  "55%, 60%": { transform: "translateY(0)" },
  "70%, 90%": { transform: `translateY(${scene.lift})` },
  "100%": { transform: "translateY(0)" },
})

const float = stylex.keyframes({
  "0%, 100%": { transform: "translateY(0)" },
  "50%": { transform: "translateY(-1.5px)" },
})

const styles = stylex.create({
  root: { display: "block", width: "100%", height: "auto", overflow: "visible" },
  text: { fontFamily: typography.mono },
  fillInk: { fill: colors.foreground },
  fillFace: { fill: colors.illustrationFace },
  fillTop: { fill: colors.illustrationTop },
  fillEnd: { fill: colors.illustrationEnd },
  fillNone: { fill: "none" },
  strokeInk: { stroke: colors.foreground, strokeLinejoin: "round" },
  strokeNone: { stroke: "none" },
  water: {
    strokeDasharray: "16 5 3 5",
    animationName: { default: glide, [conditions.reducedMotion]: "none" },
    animationDuration: motion.water,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  waterSlow: { animationDuration: motion.waterSlow, animationDirection: "reverse" },
  trolley: {
    animationName: { default: travel, [conditions.reducedMotion]: "none" },
    animationDuration: motion.crane,
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
  hoist: {
    animationName: { default: lift, [conditions.reducedMotion]: "none" },
    animationDuration: motion.crane,
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
  bob: {
    animationName: { default: float, [conditions.reducedMotion]: "none" },
    animationDuration: "4.5s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
})

const reach = stylex.create({
  distance: (value: string) => ({ [scene.reach]: value }),
})

const fills: Readonly<Record<Paint, stylex.StyleXStyles>> = {
  ink: styles.fillInk,
  face: styles.fillFace,
  top: styles.fillTop,
  end: styles.fillEnd,
  none: styles.fillNone,
}

const strokes: Readonly<Record<Paint, stylex.StyleXStyles>> = {
  ink: styles.strokeInk,
  face: styles.strokeInk,
  top: styles.strokeInk,
  end: styles.strokeInk,
  none: styles.strokeNone,
}

const isGroup = (drawing: Drawing): drawing is Group => "children" in drawing

/** A brand drawing to render, its coordinate space, and whether it moves. */
export type IllustrationConfig<Message> = SlotConfig<Message> &
  Readonly<{
    drawing: ReadonlyArray<Drawing>
    viewBox: string
    label?: string
    animated?: boolean
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: IllustrationConfig<Message>): Html => {
  const animated = config.animated !== false
  let waterRow = 0
  const figure = (part: Figure): Html => {
    const water = animated && part.className === "water"
    const slow = water && waterRow++ % 2 === 1
    const attributes = [
      ...Object.entries(part.attributes).map(([key, value]) => h.Attribute(key, String(value))),
      ...(part.strokeWidth === undefined ? [] : [h.StrokeWidth(String(part.strokeWidth))]),
      ...(part.opacity === undefined ? [] : [h.Opacity(String(part.opacity))]),
      ...styleAttributes(
        h,
        fills[part.fill],
        strokes[part.stroke],
        part.tag === "text" && styles.text,
        water && styles.water,
        slow && styles.waterSlow,
      ),
    ]
    if (part.tag === "text") return h.text(attributes, [part.text ?? ""])
    if (part.tag === "rect") return h.rect(attributes, [])
    if (part.tag === "line") return h.line(attributes, [])
    if (part.tag === "polyline") return h.polyline(attributes, [])
    return h.path(attributes, [])
  }
  const draw = (drawing: Drawing): Html =>
    isGroup(drawing)
      ? h.g(
          [
            ...styleAttributes(
              h,
              animated && styles[drawing.className],
              drawing.offset !== undefined && reach.distance(`${drawing.offset.toFixed(1)}px`),
            ),
          ],
          drawing.children.map(draw),
        )
      : figure(drawing)
  return h.svg(
    [
      h.ViewBox(config.viewBox),
      h.Attribute("preserveAspectRatio", "xMidYMid meet"),
      ...(config.label === undefined
        ? [h.AriaHidden(true)]
        : [h.Role("img"), h.AriaLabel(config.label)]),
      h.DataAttribute("slot", "illustration"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.root, config.style),
    ],
    config.drawing.map(draw),
  )
}

/**
 * Renders brand drawings (containers, quays, water, cranes) with token paints so they follow the
 * theme. Water drifts and cranes work unless the reader prefers reduced motion.
 */
export const illustration: {
  <Message>(h: HtmlBuilder<Message>, config: IllustrationConfig<Message>): Html
  <Message>(config: IllustrationConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
