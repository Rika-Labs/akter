/**
 * The paint a shape asks for. Renderers map each role to a design token, so the same geometry
 * draws correctly in light and dark themes on the website and in the console.
 */
export type Paint = "ink" | "face" | "top" | "end" | "none"

/** A framework-free SVG primitive: an element name, its geometry attributes, and its paints. */
export interface Figure {
  readonly tag: "path" | "rect" | "line" | "polyline" | "text"
  readonly attributes: Readonly<Record<string, string | number>>
  readonly fill: Paint
  readonly stroke: Paint
  readonly strokeWidth?: number
  readonly opacity?: number
  readonly text?: string
  readonly className?: "water" | "trolley" | "hoist" | "bob"
}

/** A shape group, used where an animation moves several figures together. */
export interface Group {
  readonly className: "trolley" | "hoist" | "bob"
  readonly offset?: number
  readonly children: ReadonlyArray<Drawing>
}

/** One drawable item: a primitive or a group of them. */
export type Drawing = Figure | Group

/** Formats a coordinate with one decimal so generated markup stays small and stable. */
export const fixed = (value: number): string => value.toFixed(1)
