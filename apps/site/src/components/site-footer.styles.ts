import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"
import { siteColors } from "../styles/site-tokens.stylex.ts"

export const footer = stylex.create({
  root: { marginTop: { default: "6rem", [queries.phoneDown]: "4.5rem" } },
  columns: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(4, 12.5rem) 1fr",
      [queries.tabletDown]: "repeat(2, minmax(0, 1fr))",
    },
    gap: { default: 0, [queries.tabletDown]: "2rem 1.5rem" },
    fontSize: "0.875rem",
  },
  heading: {
    fontSize: "0.875rem",
    fontWeight: 500,
    marginBottom: "0.75rem",
  },
  item: { marginBottom: "0.5rem" },
  link: {
    color: { default: siteColors.muted, ":hover": siteColors.ink },
    transitionProperty: "color",
    transitionDuration: "120ms",
  },
  brand: {
    display: "flex",
    justifyContent: { default: "flex-end", [queries.tabletDown]: "flex-start" },
    alignItems: "flex-start",
    gridColumn: { default: "auto", [queries.tabletDown]: "1 / -1" },
    order: { default: 0, [queries.tabletDown]: -1 },
  },
  strip: { marginTop: "3rem", paddingBottom: "2rem" },
})
