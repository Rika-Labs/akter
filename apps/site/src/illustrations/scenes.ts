import type { Drawing } from "@akter/ui/brand"
import { container, crane, fixed, quay, stack, water } from "@akter/ui/brand"
import { box, disc, label, path, segment } from "./figures.ts"
import type { Glyph } from "./glyphs.ts"
import { glyph } from "./glyphs.ts"
import type { SceneItem } from "./render-drawing.ts"

/** The landing page's port: two stacks, a gantry crane and the quay, over moving water. */
export const portScene: ReadonlyArray<SceneItem> = [
  ...water({ width: 1080, y: 260, rows: 6 }),
  ...stack({ x: 30, ground: 230, columns: 4, tiers: 3, seed: 5 }),
  ...stack({ x: 760, ground: 230, columns: 4, tiers: 4, seed: 9 }),
  ...crane({ x: 390, ground: 230, height: 190, reach: 250, trolley: 120, id: "AKTU 000001 7" }),
  ...quay({ width: 1080, y: 230 }),
]

/** The Order example's scene: a short stack beside a taller crane, as on the examples page. */
export const orderScene: ReadonlyArray<SceneItem> = [
  ...stack({ x: 14, ground: 260, columns: 2, tiers: 3, seed: 21 }),
  ...crane({ x: 196, ground: 260, height: 210, reach: 160, trolley: 70, id: "ORDR 008F2C 4" }),
  ...quay({ width: 470, y: 260 }),
]

/** One side of the call-to-action: a small stack on a quay. */
export const ctaStack = (seed: number): ReadonlyArray<SceneItem> => [
  ...stack({ x: 20, ground: 150, columns: 3, tiers: 3, seed, length: 56, height: 24, depth: 14 }),
  ...quay({ width: 300, y: 150, height: 16 }),
]

/** The footer's strip of single containers drifting on water. */
export const containerStrip: ReadonlyArray<SceneItem> = (() => {
  const width = 1080
  const items: Array<SceneItem> = [...water({ width, y: 112, rows: 4 })]
  let x = 10
  let index = 0
  while (x < width - 70) {
    items.push(...container({ x, y: 70 + (index % 2) * 4, length: 70, height: 30, depth: 16 }))
    x += 90 + (index % 3) * 18
    index += 1
  }
  return items
})()

/** A single container standing on a ground line, with a glyph on its face; the examples grid. */
export const containerCard = (kind: Glyph, seed: number): ReadonlyArray<SceneItem> => {
  const id = `AKTU ${200000 + seed * 4111} ${seed % 10}`
  return [
    segment(10, 128, 250, 128),
    ...container({ x: 56, y: 66, length: 128, height: 62, depth: 34, id }),
    ...glyph(kind, 56, 66),
  ]
}

const useCaseBase = (seed: number): ReadonlyArray<Drawing> => [
  segment(20, 160, 240, 160),
  ...container({
    x: 48,
    y: 98,
    length: 130,
    height: 62,
    depth: 34,
    id: `AKTU 1${seed} 3`,
  }),
]

const screen = (x: number, y: number): ReadonlyArray<SceneItem> => [
  box(x, y, 16, 11, { fill: "face" }),
  segment(x + 3, y + 15, x + 13, y + 15),
]

/**
 * The three use-case illustrations: a chat room broadcasting to screens, a billing run on a
 * schedule, and an agent session with its terminal and messages.
 */
export const useCaseScene = (
  kind: "realtime" | "background" | "agent",
): ReadonlyArray<SceneItem> => {
  const cx = 113
  const cy = 132
  if (kind === "realtime")
    return [
      ...useCaseBase(100211),
      ...[1, 2, 3].map((ring): SceneItem => ({
        motion: "pulse",
        delay: ring * 0.35,
        children: [
          path(
            `M${cx - 18 * ring} ${70 - 6 * ring} a${18 * ring} ${18 * ring} 0 0 1 ${36 * ring} 0`,
            {
              opacity: 1 - ring * 0.2,
            },
          ),
        ],
      })),
      segment(cx, 70, cx, 82),
      disc(cx, 68, 2.5, { fill: "ink" }),
      ...screen(214, 60),
      ...screen(30, 70),
      ...screen(222, 120),
    ]
  if (kind === "background")
    return [
      ...useCaseBase(100342),
      disc(cx, cy, 17, { fill: "face" }),
      {
        motion: "tick",
        origin: [cx, cy],
        children: [path(`M${cx} ${cy - 11} V${cy}`, { width: 1.4 })],
      },
      segment(cx, cy, cx + 8, cy + 5, { width: 1.4 }),
      path("M196 70 a28 28 0 1 1 -10 -20", { attributes: { "stroke-dasharray": "3 3" } }),
      path("M182 44 l5 7 l-8 2"),
    ]
  return [
    ...useCaseBase(100517),
    box(cx - 30, cy - 16, 60, 32, { fill: "ink", stroke: "none" }),
    label(cx - 24, cy + 4, ">_", 11, { fill: "face" }),
    { motion: "blink", children: [box(cx - 4, cy - 6, 3, 14, { fill: "face", stroke: "none" })] },
    {
      motion: "slide",
      children: [
        path("M196 64 h30 v18 h-22 l-8 6 z", { fill: "face" }),
        segment(202, 71, 220, 71, { opacity: 0.6 }),
        segment(202, 76, 214, 76, { opacity: 0.6 }),
      ],
    },
    {
      motion: "slide",
      delay: 1.6,
      children: [
        path("M28 60 h30 v18 h-8 v6 l-6 -6 h-16 z", { fill: "face" }),
        segment(34, 67, 52, 67, { opacity: 0.6 }),
        segment(34, 72, 44, 72, { opacity: 0.6 }),
      ],
    },
  ]
}

/** Containers on a line for a pricing tier: `count` boxes, a taller stack for bigger plans. */
export const tierScene = (count: number): ReadonlyArray<SceneItem> => {
  const items: Array<SceneItem> = [segment(10, 100, 230, 100)]
  const start = 120 - count * 18 - (count > 3 ? 20 : 0)
  for (let index = 0; index < count; index++)
    items.push(
      ...container({ x: start + index * 36, y: 72, length: 32, height: 18 + 10, depth: 8 }),
    )
  if (count >= 6)
    for (let index = 0; index < count - 3; index++)
      items.push(
        ...container({ x: start + 18 + index * 36 - 20, y: 44, length: 32, height: 28, depth: 8 }),
      )
  return items
}

/** A single crane over a quay for the Enterprise tier. */
export const tierCrane: ReadonlyArray<SceneItem> = [
  ...crane({ x: 90, ground: 100, height: 96, reach: 70, trolley: 30 }),
  segment(10, 100, 230, 100),
]

const withoutLoad = (items: ReadonlyArray<Drawing>): ReadonlyArray<Drawing> =>
  items.map((item) => {
    if (!("children" in item)) return item

    return {
      ...item,
      children: item.children.map((child) =>
        "children" in child && child.className === "hoist"
          ? { ...child, children: child.children.slice(0, 2) }
          : child,
      ),
    }
  })

/**
 * The 404 scene: two stacks and a crane whose hook is empty, waiting over a slot where a container
 * should be, drawn as a dashed outline.
 */
export const missingScene: ReadonlyArray<SceneItem> = (() => {
  const ground = 150
  const slot = { x: 330, y: ground - 26 * 3, length: 72, height: 26, depth: 12 }
  const dx = fixed(slot.depth * Math.cos(Math.PI / 6))
  const dy = fixed(-slot.depth * Math.sin(Math.PI / 6))
  const back = fixed(-slot.depth * Math.cos(Math.PI / 6))
  const down = fixed(slot.depth * Math.sin(Math.PI / 6))
  const dashed = { attributes: { "stroke-dasharray": "3 3" }, opacity: 0.6 }

  return [
    ...water({ width: 420, y: ground + 22, rows: 3 }),
    ...stack({ x: 236, ground, columns: 1, tiers: 3, seed: 3, length: 72, height: 26, depth: 12 }),
    ...container({ x: 330, y: ground - 26, length: 72, height: 26, depth: 12 }),
    ...container({ x: 330, y: ground - 52, length: 72, height: 26, depth: 12 }),
    box(slot.x, slot.y, slot.length, slot.height, dashed),
    path(`M${slot.x} ${slot.y} l${dx} ${dy} h${slot.length} l${back} ${down}`, dashed),
    path(`M${slot.x + slot.length} ${slot.y} l${dx} ${dy} v${slot.height}`, dashed),
    ...withoutLoad(crane({ x: 70, ground, height: 120, reach: 270, trolley: 230 })),
    ...quay({ width: 420, y: ground, height: 16 }),
  ]
})()
