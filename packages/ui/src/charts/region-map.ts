import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { illustration } from "../components/illustration.ts"
import { statusDot } from "../components/status.ts"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { regionScene } from "../geometry/regions.ts"
import { colors, conditions, space, typography } from "../tokens.stylex.ts"
import { percent, placement } from "./styles.ts"

const styles = stylex.create({
  root: { position: "relative", margin: 0, minWidth: 0, paddingBlockStart: "2.75rem" },
  label: {
    position: "absolute",
    insetBlockStart: 0,
    translate: "-50% 0",
    display: "grid",
    justifyItems: "center",
    gap: space.xxs,
    textAlign: "center",
    whiteSpace: "nowrap",
  },
  name: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s,
    fontFamily: typography.mono,
    fontSize: typography.caption,
    fontWeight: 500,
  },
  detail: {
    color: colors.mutedForeground,
    fontSize: { default: typography.caption, [conditions.compact]: typography.micro },
  },
})

/** A region: its id, where it is, how many tenants it hosts, and whether it is primary. */
export interface RegionPin {
  readonly id: string
  readonly place: string
  readonly tenants: number
  readonly primary: boolean
  readonly healthy: boolean
}

/**
 * Regions as container yards on one harbour: each yard's stack sized by its tenants, the primary
 * yard with its crane at work, and each region's name above its yard.
 */
export type RegionMapConfig<Message> = SlotConfig<Message> &
  Readonly<{
    label: string
    regions: ReadonlyArray<RegionPin>
    formatTenants: (tenants: number) => string
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: RegionMapConfig<Message>): Html => {
  const scene = regionScene({
    regions: config.regions.map((region) => ({
      id: region.id,
      tenants: region.tenants,
      primary: region.primary,
    })),
  })
  return h.figure(
    [
      h.DataAttribute("slot", "region-map"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.root, config.style),
    ],
    [
      illustration(h, {
        drawing: scene.drawing,
        viewBox: scene.viewBox,
        label: `${config.label}: ${config.regions
          .map(
            (region) => `${region.id} in ${region.place}, ${config.formatTenants(region.tenants)}`,
          )
          .join("; ")}`,
      }),
      ...config.regions.map((region, index) =>
        h.figcaption(
          [
            h.AriaHidden(true),
            ...styleAttributes(
              h,
              styles.label,
              placement.left(percent(scene.anchors[index]?.x ?? 0.5)),
            ),
          ],
          [
            h.span(
              [...styleAttributes(h, styles.name)],
              [statusDot(h, region.healthy ? "live" : "warning"), region.id],
            ),
            h.span(
              [...styleAttributes(h, styles.detail)],
              [
                `${region.place} · ${config.formatTenants(region.tenants)}${region.primary ? " · primary" : ""}`,
              ],
            ),
          ],
        ),
      ),
    ],
  )
}

/** The region and tenant map. */
export const regionMap: {
  <Message>(h: HtmlBuilder<Message>, config: RegionMapConfig<Message>): Html
  <Message>(config: RegionMapConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
