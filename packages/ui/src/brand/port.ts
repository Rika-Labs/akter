import { type Drawing, type Figure, fixed } from "./figure.ts"

const COS30 = Math.cos(Math.PI / 6)
const SIN30 = Math.sin(Math.PI / 6)

const path = (
  d: string,
  fill: Figure["fill"],
  stroke: Figure["stroke"],
  extra: Partial<Figure> = {},
): Figure => ({
  tag: "path",
  attributes: { d },
  fill,
  stroke,
  strokeWidth: 1,
  ...extra,
})

/** Where one isometric shipping container sits, its size, and its painted id. */
export interface ContainerOptions {
  readonly x: number
  readonly y: number
  readonly length: number
  readonly height: number
  readonly depth: number
  readonly id?: string | undefined
  readonly strokeWidth?: number
}

/**
 * One isometric container with its long face at (x, y), corrugation ribs on the face and locking
 * bars on the doors. Depth recedes up and to the right at thirty degrees.
 */
export const container = (options: ContainerOptions): ReadonlyArray<Figure> => {
  const { x, y, length, height, depth } = options
  const dx = depth * COS30
  const dy = -depth * SIN30
  const width = options.strokeWidth ?? 1
  const ribs = Math.max(6, Math.round(length / 7))
  const figures: Array<Figure> = [
    path(
      `M${fixed(x)} ${fixed(y)} l${fixed(dx)} ${fixed(dy)} h${fixed(length)} l${fixed(-dx)} ${fixed(-dy)} z`,
      "top",
      "ink",
      { strokeWidth: width },
    ),
    {
      tag: "rect",
      attributes: { x: fixed(x), y: fixed(y), width: fixed(length), height: fixed(height) },
      fill: "face",
      stroke: "ink",
      strokeWidth: width,
    },
    path(
      `M${fixed(x + length)} ${fixed(y)} l${fixed(dx)} ${fixed(dy)} v${fixed(height)} l${fixed(-dx)} ${fixed(-dy)} z`,
      "end",
      "ink",
      { strokeWidth: width },
    ),
  ]
  for (let rib = 1; rib < ribs; rib++) {
    const rx = x + (length * rib) / ribs
    figures.push(
      path(`M${fixed(rx)} ${fixed(y + 1.5)} V${fixed(y + height - 1.5)}`, "none", "ink", {
        opacity: 0.45,
      }),
    )
  }
  for (let bar = 1; bar <= 4; bar++) {
    const t = bar / 5
    figures.push(
      path(
        `M${fixed(x + length + dx * t)} ${fixed(y + dy * t + 2)} v${fixed(height - 4)}`,
        "none",
        "ink",
        { opacity: 0.45 },
      ),
    )
  }
  if (options.id !== undefined && length > 70) {
    figures.push({
      tag: "text",
      attributes: { x: fixed(x + 5), y: fixed(y + 9), "font-size": 6.2, "letter-spacing": 0.6 },
      fill: "ink",
      stroke: "none",
      text: options.id,
    })
  }
  return figures
}

/** Where a quay edge runs. */
export interface QuayOptions {
  readonly width: number
  readonly y: number
  readonly height?: number
}

/** A hatched quay edge at `y`, with bollards every 140 units. */
export const quay = (options: QuayOptions): ReadonlyArray<Figure> => {
  const { width, y } = options
  const height = options.height ?? 22
  const figures: Array<Figure> = [
    path(`M0 ${y} H${width}`, "none", "ink"),
    path(`M0 ${y + height} H${width}`, "none", "ink", { opacity: 0.3 }),
  ]
  for (let x = -height; x < width; x += 7)
    figures.push(path(`M${x} ${y + height} L${x + height} ${y}`, "none", "ink", { opacity: 0.18 }))
  for (let x = 30; x < width; x += 140)
    figures.push({
      tag: "rect",
      attributes: { x, y: y - 5, width: 8, height: 5 },
      fill: "ink",
      stroke: "none",
    })
  return figures
}

/** Where the water starts and how many dashed rows it has. */
export interface WaterOptions {
  readonly width: number
  readonly y: number
  readonly rows?: number
}

/** Dashed water lines below a quay; renderers animate the `water` class by moving the dash offset. */
export const water = ({ width, y, rows = 5 }: WaterOptions): ReadonlyArray<Figure> =>
  Array.from({ length: rows }, (_, row) =>
    path(`M${-((row * 23) % 40)} ${y + row * 7} H${width + 40}`, "none", "ink", {
      opacity: Math.max(0.04, 0.2 - row * 0.03),
      className: "water",
    }),
  )

const lattice = (
  left: number,
  bottom: number,
  right: number,
  top: number,
  cells: number,
  mirrored: boolean,
): ReadonlyArray<Figure> => {
  const figures: Array<Figure> = []
  for (let cell = 0; cell < cells; cell++) {
    const from = bottom + ((top - bottom) * cell) / cells
    const to = bottom + ((top - bottom) * (cell + 1)) / cells
    figures.push(
      path(
        mirrored
          ? `M${left} ${fixed(from)} L${right} ${fixed(to)}`
          : `M${right} ${fixed(from)} L${left} ${fixed(to)}`,
        "none",
        "ink",
        { strokeWidth: 0.8 },
      ),
    )
    figures.push(
      path(`M${left} ${fixed(to)} H${right}`, "none", "ink", { strokeWidth: 0.8, opacity: 0.5 }),
    )
  }
  return figures
}

/** Where the gantry crane stands, its size, and where its trolley rests. */
export interface CraneOptions {
  readonly x: number
  readonly ground: number
  readonly height: number
  readonly reach: number
  readonly trolley?: number
  readonly id?: string
}

/**
 * A ship-to-shore gantry crane standing on `ground`, its boom reaching `reach` to the right, with a
 * container hanging from the trolley. The trolley and hoist are groups so renderers can animate them.
 */
export const crane = (options: CraneOptions): ReadonlyArray<Drawing> => {
  const { x, ground, height, reach } = options
  const top = ground - height
  const leg = 46
  const frame: Array<Figure> = [
    path(`M${x} ${ground} V${top}`, "none", "ink", { strokeWidth: 1.1 }),
    path(`M${x + 8} ${ground} V${top}`, "none", "ink", { strokeWidth: 1.1 }),
    path(`M${x + leg} ${ground} V${top}`, "none", "ink", { strokeWidth: 1.1 }),
    path(`M${x + leg + 8} ${ground} V${top}`, "none", "ink", { strokeWidth: 1.1 }),
    ...lattice(x, ground - 4, x + 8, top + 4, 9, false),
    ...lattice(x + leg, ground - 4, x + leg + 8, top + 4, 9, true),
    path(`M${x} ${top + height * 0.42} H${x + leg + 8}`, "none", "ink", { strokeWidth: 1.1 }),
    path(`M${x} ${top + height * 0.42 + 6} H${x + leg + 8}`, "none", "ink", { strokeWidth: 1.1 }),
    path(`M${x - 70} ${top} H${x + leg + reach}`, "none", "ink", { strokeWidth: 1.1 }),
    path(`M${x - 70} ${top + 9} H${x + leg + reach}`, "none", "ink", { strokeWidth: 1.1 }),
    path(`M${x + 4} ${top} L${x + leg / 2 + 4} ${top - 34} L${x + leg + 4} ${top}`, "none", "ink", {
      strokeWidth: 1.1,
    }),
    path(`M${x + leg / 2 + 4} ${top - 34} L${x + leg + reach - 8} ${top}`, "none", "ink", {
      opacity: 0.6,
    }),
    path(`M${x + leg / 2 + 4} ${top - 34} L${x - 66} ${top}`, "none", "ink", { opacity: 0.6 }),
    {
      tag: "rect",
      attributes: { x: x - 70, y: top + 9, width: 26, height: 14 },
      fill: "ink",
      stroke: "none",
    },
    {
      tag: "rect",
      attributes: { x: x + 12, y: top + 12, width: 22, height: 16 },
      fill: "face",
      stroke: "ink",
      strokeWidth: 1.1,
    },
  ]
  for (let bx = x - 70; bx < x + leg + reach; bx += 12)
    frame.push(
      path(`M${bx} ${top + 9} L${bx + 6} ${top} L${bx + 12} ${top + 9}`, "none", "ink", {
        strokeWidth: 0.8,
      }),
    )
  const tx = x + leg + (options.trolley ?? reach * 0.55)
  const hoist: Drawing = {
    className: "hoist",
    children: [
      path(
        `M${tx - 5} ${top + 16} V${top + 56} M${tx + 5} ${top + 16} V${top + 56}`,
        "none",
        "ink",
        { strokeWidth: 0.8 },
      ),
      path(`M${tx - 34} ${top + 56} H${tx + 34}`, "none", "ink", { strokeWidth: 2.2 }),
      ...container({
        x: tx - 32,
        y: top + 58,
        length: 64,
        height: 28,
        depth: 16,
        id: options.id,
      }),
    ],
  }
  return [
    ...frame,
    {
      className: "trolley",
      offset: reach * 0.3,
      children: [
        {
          tag: "rect",
          attributes: { x: tx - 9, y: top + 9, width: 18, height: 7 },
          fill: "ink",
          stroke: "none",
        },
        hoist,
      ],
    },
  ]
}

const seeded = (seed: number) => {
  let state = seed
  return () => {
    state = (state * 9301 + 49297) % 233280
    return state / 233280
  }
}

/** Where a stack stands, its columns and tiers, and the seed that keeps its heights and ids stable. */
export interface StackOptions {
  readonly x: number
  readonly ground: number
  readonly columns: number
  readonly tiers: number
  readonly seed: number
  readonly length?: number
  readonly height?: number
  readonly depth?: number
}

/** Columns of stacked containers on `ground`. */
export const stack = (options: StackOptions): ReadonlyArray<Figure> => {
  const { x, ground, columns, tiers, seed, length = 64, height = 28, depth = 16 } = options
  const random = seeded(seed)
  const figures: Array<Figure> = []
  for (let column = 0; column < columns; column++) {
    const count = Math.max(1, Math.round(tiers - random() * (tiers - 1)))
    for (let tier = 0; tier < count; tier++) {
      const id = `AKTU ${String(Math.floor(random() * 900000) + 100000)} ${Math.floor(random() * 10)}`
      figures.push(
        ...container({
          x: x + column * (length + 4),
          y: ground - height * (tier + 1),
          length,
          height,
          depth,
          id,
        }),
      )
    }
  }
  return figures
}
