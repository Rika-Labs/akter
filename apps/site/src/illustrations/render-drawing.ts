import type { Drawing, Figure, Group, Paint } from "@akter/ui/brand"
import * as stylex from "@stylexjs/stylex"
import { escapeMarkup } from "../escape-markup.ts"
import { fills, hoistFills, motion, strokes, text } from "./render-drawing.styles.ts"

const classOf = (...styles: ReadonlyArray<stylex.StyleXStyles | false>): string =>
  stylex.props(...styles).className ?? ""

const paintStroke = (paint: Paint) => strokes[paint]

const attributeList = (attributes: Readonly<Record<string, string | number>>): string =>
  Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${escapeMarkup(String(value))}"`)
    .join("")

const isGroup = (item: Drawing): item is Group => "children" in item

/**
 * Renders brand descriptors to inline SVG markup. Paints become StyleX classes on each element so
 * the same geometry follows the theme, and the animated classes become CSS animations that are
 * switched off for visitors who prefer reduced motion.
 */
export const renderDrawing = (items: ReadonlyArray<Drawing>): string => {
  let waterRows = 0
  let hoisted = false

  const figure = (item: Figure): string => {
    const water = item.className === "water"
    const animation = water
      ? classOf(motion.water, waterRows++ % 2 === 1 && motion.waterReverse)
      : ""
    const classes = [
      classOf(
        (hoisted ? hoistFills : fills)[item.fill],
        paintStroke(item.stroke),
        item.tag === "text" && text.mono,
      ),
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
    const outer = hoisted
    hoisted = hoisted || item.className === "hoist"
    const children = item.children.map(render).join("")
    hoisted = outer
    return `<g class="${classOf(motion[item.className])}"${offset}>${children}</g>`
  }

  const render = (item: Drawing): string => {
    if (isGroup(item)) return group(item)
    return figure(item)
  }

  return items.map(render).join("")
}
