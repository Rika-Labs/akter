import type { Drawing, Figure, Group, Paint } from "@akter/ui/brand"
import * as stylex from "@stylexjs/stylex"
import { escapeMarkup } from "../escape-markup.ts"
import { fills, motion, strokes, text } from "./render-drawing.styles.ts"

/** The motion classes this site adds to the brand's own `trolley`, `hoist` and `bob` groups. */
export type Motion = "slide" | "pulse" | "tick" | "blink"

/** A group that animates its children with one of the site's local motions. */
export interface MotionGroup {
  readonly motion: Motion
  readonly delay?: number
  readonly origin?: readonly [number, number]
  readonly children: ReadonlyArray<SceneItem>
}

/** Anything a scene can contain: the brand's drawings plus the site's motion groups. */
export type SceneItem = Drawing | MotionGroup

const classOf = (...styles: ReadonlyArray<stylex.StyleXStyles | false>): string =>
  stylex.props(...styles).className ?? ""

const paintFill = (paint: Paint) => fills[paint]

const paintStroke = (paint: Paint) => strokes[paint]

const attributeList = (attributes: Readonly<Record<string, string | number>>): string =>
  Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${escapeMarkup(String(value))}"`)
    .join("")

const isMotionGroup = (item: SceneItem): item is MotionGroup => "motion" in item

const isBrandGroup = (item: Drawing): item is Group => "children" in item

/**
 * Renders brand descriptors to inline SVG markup. Paints become StyleX classes on each element so
 * the same geometry follows the theme, and the animated classes become CSS animations that are
 * switched off for visitors who prefer reduced motion.
 */
export const renderDrawing = (items: ReadonlyArray<SceneItem>): string => {
  let waterRows = 0

  const figure = (item: Figure): string => {
    const water = item.className === "water"
    const animation = water
      ? classOf(motion.water, waterRows++ % 2 === 1 && motion.waterReverse)
      : ""
    const classes = [
      classOf(paintFill(item.fill), paintStroke(item.stroke), item.tag === "text" && text.mono),
      animation,
    ]
      .filter((name) => name !== "")
      .join(" ")
    const stroke = item.stroke === "none" ? "" : ` stroke-width="${item.strokeWidth ?? 1}"`
    const opacity = item.opacity === undefined ? "" : ` opacity="${item.opacity}"`
    const join = item.stroke === "none" ? "" : ' stroke-linejoin="round"'
    const open = `<${item.tag} class="${classes}"${stroke}${opacity}${join}${attributeList(item.attributes)}`
    return item.tag === "text" ? `${open}>${escapeMarkup(item.text ?? "")}</text>` : `${open}/>`
  }

  const group = (item: Group): string => {
    const offset = item.offset === undefined ? "" : ` style="--reach:${item.offset.toFixed(1)}px"`
    return `<g class="${classOf(motion[item.className])}"${offset}>${item.children.map(render).join("")}</g>`
  }

  const motionGroup = (item: MotionGroup): string => {
    const declarations = [
      item.delay === undefined ? "" : `animation-delay:${item.delay}s`,
      item.origin === undefined ? "" : `transform-origin:${item.origin[0]}px ${item.origin[1]}px`,
    ].filter((declaration) => declaration !== "")
    const style = declarations.length === 0 ? "" : ` style="${declarations.join(";")}"`
    return `<g class="${classOf(motion[item.motion])}"${style}>${item.children.map(render).join("")}</g>`
  }

  const render = (item: SceneItem): string => {
    if (isMotionGroup(item)) return motionGroup(item)
    if (isBrandGroup(item)) return group(item)
    return figure(item)
  }

  return items.map(render).join("")
}
