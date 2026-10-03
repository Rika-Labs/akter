import type { Figure, Paint } from "@akter/ui/brand"
import { fixed } from "@akter/ui/brand"

/** Appearance for one drawn figure; omitted fields draw a one-pixel ink outline with no fill. */
export interface Look {
  readonly fill?: Paint
  readonly stroke?: Paint
  readonly width?: number
  readonly opacity?: number
  readonly radius?: number
  readonly attributes?: Readonly<Record<string, string | number>>
}

const figure = (
  tag: Figure["tag"],
  attributes: Readonly<Record<string, string | number>>,
  look: Look,
): Figure => ({
  tag,
  attributes: { ...attributes, ...look.attributes },
  fill: look.fill ?? "none",
  stroke: look.stroke ?? "ink",
  strokeWidth: look.width ?? 1,
  opacity: look.opacity,
})

/** A path from SVG path data. */
export const path = (d: string, look: Look = {}): Figure => figure("path", { d }, look)

/** An axis-aligned rectangle with optional corner radius. */
export const box = (x: number, y: number, width: number, height: number, look: Look = {}): Figure =>
  figure(
    "rect",
    { x: fixed(x), y: fixed(y), width: fixed(width), height: fixed(height), rx: look.radius ?? 0 },
    look,
  )

/** A circle drawn as two arcs, because the brand's figure vocabulary has no circle element. */
export const disc = (cx: number, cy: number, r: number, look: Look = {}): Figure =>
  path(
    `M${fixed(cx - r)} ${fixed(cy)} a${r} ${r} 0 1 0 ${fixed(2 * r)} 0 a${r} ${r} 0 1 0 ${fixed(-2 * r)} 0`,
    look,
  )

/** A straight segment drawn with a path so every figure shares one stroke treatment. */
export const segment = (x1: number, y1: number, x2: number, y2: number, look: Look = {}): Figure =>
  path(`M${fixed(x1)} ${fixed(y1)} L${fixed(x2)} ${fixed(y2)}`, look)

/** Monospaced label text in ink, sized in SVG user units. */
export const label = (
  x: number,
  y: number,
  content: string,
  size: number,
  look: Look = {},
): Figure => ({
  ...figure("text", { x: fixed(x), y: fixed(y), "font-size": size }, { ...look, stroke: "none" }),
  fill: look.fill ?? "ink",
  text: content,
})
