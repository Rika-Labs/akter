import type { Figure } from "@akter/ui/brand"
import { quay, water } from "@akter/ui/brand"
import { box, disc, label, path, segment } from "./figures.ts"
import type { SceneItem } from "./render-drawing.ts"

const X = 40
const Y = 70
const LENGTH = 330
const HEIGHT = 150
const DEPTH = 70
const DX = DEPTH * Math.cos(Math.PI / 6)
const DY = -DEPTH * Math.sin(Math.PI / 6)

/** The cutaway's coordinate space: wide enough for the incoming messages and the live-client arcs. */
export const cutawayViewBox = "-110 -10 560 300"

const crate = (
  x: number,
  y: number,
  width: number,
  height: number,
  title: string,
  detail: string,
): ReadonlyArray<Figure> => [
  box(x, y, width, height, { fill: "face" }),
  path(`M${x} ${y} l10 -6 h${width} l-10 6`, { fill: "top" }),
  path(`M${x + width} ${y} l10 -6 v${height} l-10 6`, { fill: "end" }),
  label(x + 7, y + 15, title, 9, { attributes: { "letter-spacing": 0.8 } }),
  label(x + 7, y + 27, detail, 7.5, { opacity: 0.6 }),
]

const message = (index: number): SceneItem => {
  const x = X - 30 - index * 26
  const y = Y + 54
  return {
    motion: "slide",
    delay: index * 0.5,
    children: [box(x, y, 20, 14, { fill: "face" }), path(`M${x} ${y} l10 7 l10 -7`)],
  }
}

const badge = (number: number, x: number, y: number): ReadonlyArray<Figure> => [
  disc(x, y, 10, { fill: "ink", stroke: "none" }),
  label(x - 3.6, y + 4, String(number), 11.5, { fill: "face" }),
]

/**
 * The landing page's cutaway container: an actor with its address on the door, four crates inside
 * (state, a table, events, jobs), commands arriving at the left and live clients listening above.
 * Numbered badges match the legend beside it.
 */
export const cutaway: ReadonlyArray<SceneItem> = (() => {
  const items: Array<SceneItem> = [...water({ width: 460, y: Y + HEIGHT + 30, rows: 5 })]

  items.push(path(`M${X + DX} ${Y + DY} h${LENGTH} v${HEIGHT} h${-LENGTH} z`, { fill: "end" }))
  for (let rib = 1; rib < 22; rib++) {
    const x = X + DX + (LENGTH * rib) / 22
    items.push(path(`M${x} ${Y + DY + 2} V${Y + DY + HEIGHT - 2}`, { opacity: 0.25 }))
  }
  items.push(
    path(`M${X} ${Y + HEIGHT} l${DX} ${DY} h${LENGTH} l${-DX} ${-DY} z`, { fill: "top" }),
    path(`M${X} ${Y} l${DX} ${DY} V${Y + DY + HEIGHT} M${X} ${Y} V${Y + HEIGHT}`),
  )
  items.push(
    ...crate(X + 34, Y + HEIGHT - 44, 92, 44, "STATE", "total · chargeId"),
    ...crate(X + 138, Y + HEIGHT - 58, 110, 58, "TABLE", "order_lines"),
    ...crate(X + 260, Y + HEIGHT - 36, 74, 36, "JOBS", "Charge"),
    ...crate(X + 150, Y + HEIGHT - 98, 86, 38, "EVENTS", "OrderPlaced"),
  )
  items.push(
    path(`M${X} ${Y} l${DX} ${DY} h${LENGTH} l${-DX} ${-DY} z`, { fill: "top" }),
    path(`M${X + LENGTH} ${Y} l${DX} ${DY} v${HEIGHT} l${-DX} ${-DY} z`, { fill: "end" }),
  )
  for (let bar = 1; bar <= 4; bar++) {
    const t = bar / 5
    items.push(path(`M${X + LENGTH + DX * t} ${Y + DY * t + 3} v${HEIGHT - 6}`, { opacity: 0.5 }))
  }
  items.push(
    path(`M${X} ${Y} H${X + LENGTH} V${Y + HEIGHT} H${X} Z`, { width: 2.2 }),
    label(X + 6, Y - 6, "ORDR 008F2C 4 · Order/ord_8f2c", 8, {
      attributes: { "letter-spacing": 0.8 },
    }),
  )
  items.push(message(2), message(1), message(0))
  items.push(segment(X - 8, Y + 61, X + 6, Y + 61), path(`M${X + 1} ${Y + 57} l5 4 l-5 4`))
  for (let ring = 1; ring <= 2; ring++)
    items.push({
      motion: "pulse",
      delay: ring * 0.45,
      children: [
        path(
          `M${X + LENGTH + DX + 10 - 8 * ring} ${Y + DY - 10 - 8 * ring} a${10 * ring} ${10 * ring} 0 0 1 ${20 * ring} 0`,
          {
            opacity: 1 - ring * 0.3,
          },
        ),
      ],
    })
  items.push(
    ...badge(1, X + 2, Y - 34),
    ...badge(2, X - 56, Y + 46),
    ...badge(3, X + 92, Y + 82),
    ...badge(4, X + 262, Y + 86),
    ...badge(5, X + LENGTH + DX + 22, Y + DY + 6),
  )
  items.push(
    ...quay({ width: 460, y: Y + HEIGHT, height: 22 }).filter((figure) => figure.tag !== "rect"),
  )

  return items
})()
