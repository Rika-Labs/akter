import type { Figure } from "@akter/ui/brand"
import { box, disc, label, path, segment } from "./figures.ts"
import type { SceneItem } from "./render-drawing.ts"

/** The marks painted on a container's long face, one per kind of actor the site talks about. */
export type Glyph =
  | "counter"
  | "order"
  | "chat"
  | "agent"
  | "document"
  | "device"
  | "schedule"
  | "tenant"

const softLines = (x: number, y: number, widths: ReadonlyArray<number>): ReadonlyArray<Figure> =>
  widths.map((width, row) => segment(x, y + row * 6, x + width, y + row * 6, { opacity: 0.55 }))

/**
 * A glyph centred on the long face of a container whose top-left face corner is `(x, y)`. The
 * container art in the examples grid and the landing use cases place these.
 */
export const glyph = (kind: Glyph, x: number, y: number): ReadonlyArray<SceneItem> => {
  switch (kind) {
    case "counter":
      return [label(x + 46, y + 40, "+1", 22, { attributes: { "font-weight": 500 } })]
    case "order":
      return [
        box(x + 40, y + 18, 34, 26, { fill: "face" }),
        ...softLines(x + 46, y + 26, [22, 16, 19]),
      ]
    case "chat":
      return [
        path(`M${x + 36} ${y + 16} h44 v22 h-30 l-8 7 v-7 h-6 z`, { fill: "face" }),
        ...softLines(x + 44, y + 24, [28, 18]),
      ]
    case "agent":
      return [
        box(x + 34, y + 16, 50, 28, { fill: "ink", stroke: "none" }),
        label(x + 40, y + 34, ">_", 11, { fill: "face" }),
        {
          motion: "blink",
          children: [box(x + 58, y + 24, 2.5, 12, { fill: "face", stroke: "none" })],
        },
      ]
    case "document":
      return [
        path(`M${x + 42} ${y + 12} h24 l8 8 v28 h-32 z`, { fill: "face" }),
        ...softLines(x + 48, y + 26, [20, 20, 12]),
        path(`M${x + 80} ${y + 30} l6 12 l2 -5 l5 -2 z`, { fill: "ink" }),
      ]
    case "device":
      return [
        box(x + 42, y + 16, 34, 26, { fill: "face", radius: 3 }),
        path(`M${x + 46} ${y + 34} l6 -8 l6 4 l6 -10 l6 6`),
      ]
    case "schedule":
      return [
        disc(x + 59, y + 30, 15, { fill: "face" }),
        {
          motion: "tick",
          origin: [x + 59, y + 30],
          children: [path(`M${x + 59} ${y + 20} V${y + 30}`, { width: 1.4 })],
        },
        segment(x + 59, y + 30, x + 66, y + 34, { width: 1.4 }),
      ]
    case "tenant":
      return [
        path(`M${x + 38} ${y + 44} v-20 l10 -8 l10 8 v20 z M${x + 60} ${y + 44} v-26 h20 v26 z`, {
          fill: "face",
        }),
      ]
  }
}
