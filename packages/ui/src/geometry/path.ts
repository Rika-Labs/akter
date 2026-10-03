/** A point in chart coordinates. */
export interface Point {
  readonly x: number
  readonly y: number
}

/** How consecutive points are joined. */
export type Curve = "linear" | "monotone" | "step"

const fixed = (value: number): string => value.toFixed(2).replace(/\.?0+$/u, "")

/**
 * Tangents for monotone cubic interpolation (Fritsch–Carlson): smooth through every point without
 * overshooting between them, so a smoothed latency line never dips below its real minimum.
 */
const tangents = (points: ReadonlyArray<Point>): ReadonlyArray<number> => {
  const count = points.length
  const slopes = points.slice(0, -1).map((point, index) => {
    const next = points[index + 1] ?? point
    const dx = next.x - point.x
    return dx === 0 ? 0 : (next.y - point.y) / dx
  })
  const result = points.map((_, index) => {
    if (index === 0) return slopes[0] ?? 0
    if (index === count - 1) return slopes[count - 2] ?? 0
    const before = slopes[index - 1] ?? 0
    const after = slopes[index] ?? 0
    return before * after <= 0 ? 0 : (before + after) / 2
  })
  slopes.forEach((slope, index) => {
    if (slope === 0) return
    const a = (result[index] ?? 0) / slope
    const b = (result[index + 1] ?? 0) / slope
    const length = a * a + b * b
    if (length > 9) {
      const scale = 3 / Math.sqrt(length)
      result[index] = scale * a * slope
      result[index + 1] = scale * b * slope
    }
  })
  return result
}

const segments = (points: ReadonlyArray<Point>, curve: Curve): string => {
  if (curve === "step")
    return points
      .slice(1)
      .map((point) => `H${fixed(point.x)}V${fixed(point.y)}`)
      .join("")
  if (curve === "linear" || points.length < 3)
    return points
      .slice(1)
      .map((point) => `L${fixed(point.x)} ${fixed(point.y)}`)
      .join("")
  const slopes = tangents(points)
  return points
    .slice(1)
    .map((point, offset) => {
      const previous = points[offset] ?? point
      const dx = (point.x - previous.x) / 3
      const c1 = { x: previous.x + dx, y: previous.y + dx * (slopes[offset] ?? 0) }
      const c2 = { x: point.x - dx, y: point.y - dx * (slopes[offset + 1] ?? 0) }
      return `C${fixed(c1.x)} ${fixed(c1.y)} ${fixed(c2.x)} ${fixed(c2.y)} ${fixed(point.x)} ${fixed(point.y)}`
    })
    .join("")
}

/** An SVG path through `points`, joined by `curve`. Empty input draws nothing. */
export const linePath = (
  input: Readonly<{ points: ReadonlyArray<Point>; curve: Curve }>,
): string => {
  const first = input.points[0]
  if (first === undefined) return ""
  return `M${fixed(first.x)} ${fixed(first.y)}${segments(input.points, input.curve)}`
}

/** A closed SVG path filling the area between the line through `points` and the `baseline` y. */
export const areaPath = (
  input: Readonly<{ points: ReadonlyArray<Point>; curve: Curve; baseline: number }>,
): string => {
  const first = input.points[0]
  const last = input.points.at(-1)
  if (first === undefined || last === undefined) return ""
  return `${linePath(input)}L${fixed(last.x)} ${fixed(input.baseline)}L${fixed(first.x)} ${fixed(input.baseline)}Z`
}
