import type { Figure } from "./figure.ts"

/** The segmented Ak mark's coordinate space. */
export const markViewBox = "0 0 28 28"

const capsule = (x1: number, y1: number, x2: number, y2: number): Figure => ({
  tag: "line",
  attributes: { x1, y1, x2, y2, "stroke-linecap": "round" },
  fill: "none",
  stroke: "ink",
  strokeWidth: 3.4,
})

/**
 * The segmented Ak: an A and a k sharing one stem, every stroke a capsule like the Rika Labs R.
 * The A's peak is one rounded polyline so the two strokes read as one letter.
 */
export const mark: ReadonlyArray<Figure> = [
  capsule(3.6, 24.6, 6.6, 16.6),
  {
    tag: "polyline",
    attributes: {
      points: "8.4,12.2 12.2,3.4 12.2,12.2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    },
    fill: "none",
    stroke: "ink",
    strokeWidth: 3.4,
  },
  capsule(12.2, 16.8, 12.2, 24.6),
  capsule(16.6, 13.2, 24.4, 5),
  capsule(18.8, 17.8, 19.8, 19),
  capsule(22.8, 22.6, 24.4, 24.6),
]
