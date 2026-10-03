import type { Drawing } from "../brand/figure.ts"
import { crane, quay, stack, water } from "../brand/port.ts"

/** A region's yard: how many tenants call it home, and whether it is the primary region. */
export interface RegionYard {
  readonly id: string
  readonly tenants: number
  readonly primary: boolean
}

/** Where a region's label sits over the scene, as fractions of its width and height. */
export interface RegionAnchor {
  readonly id: string
  readonly x: number
  readonly y: number
}

/** A drawable harbour of regions and the anchors for their labels. */
export interface RegionScene {
  readonly viewBox: string
  readonly width: number
  readonly height: number
  readonly drawing: ReadonlyArray<Drawing>
  readonly anchors: ReadonlyArray<RegionAnchor>
}

const width = 1000
const top = 40
const height = 300
const ground = 236
const length = 56
const tiers = 3

/**
 * A harbour with one container yard per region. Each yard's stack grows with the share of tenants
 * homed there (one to six columns), so the busiest region reads as the busiest yard; the primary
 * region's crane is mid-lift. Seeds come from the region id so the same region always draws the same.
 */
export const regionScene = (
  input: Readonly<{ regions: ReadonlyArray<RegionYard> }>,
): RegionScene => {
  const count = Math.max(1, input.regions.length)
  const busiest = Math.max(1, ...input.regions.map((region) => region.tenants))
  const segment = width / count
  const drawing: Array<Drawing> = [
    ...water({ width, y: ground + 34, rows: 5 }),
    ...quay({ width, y: ground, height: 22 }),
  ]
  const anchors = input.regions.map((region, index) => {
    const columns = Math.max(1, Math.min(6, Math.round((6 * region.tenants) / busiest)))
    const stackWidth = columns * (length + 4)
    const center = segment * index + segment / 2
    const x = Math.max(
      segment * index + (region.primary ? 160 : 24),
      center - stackWidth / 2 + (region.primary ? 40 : 0),
    )
    const seed = Array.from({ length: region.id.length }, (_, at) =>
      region.id.charCodeAt(at),
    ).reduce((sum, code) => sum + code, 7)
    if (region.primary)
      drawing.push(
        ...crane({
          x: x - 76,
          ground,
          height: 158,
          reach: Math.max(120, stackWidth * 0.7),
          trolley: Math.max(60, stackWidth * 0.35),
          id: "AKTU 000001 7",
        }),
      )
    drawing.push(...stack({ x, ground, columns, tiers, seed, length, height: 26, depth: 14 }))
    return { id: region.id, x: center / width, y: 0 }
  })
  return {
    viewBox: `0 ${top} ${width} ${height - top}`,
    width,
    height: height - top,
    drawing,
    anchors,
  }
}
