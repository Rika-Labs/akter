import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"
import { siteColors } from "../styles/site-tokens.stylex.ts"

export const section = stylex.create({
  root: {
    display: "grid",
    gridTemplateColumns: {
      default: "18.75rem minmax(0, 1fr)",
      [queries.tabletDown]: "minmax(0, 1fr)",
    },
    columnGap: "5rem",
    rowGap: { default: 0, [queries.tabletDown]: "1.5rem" },
    marginTop: { default: "6rem", [queries.phoneDown]: "4rem" },
    paddingTop: { default: "2.5rem", [queries.phoneDown]: "1.75rem" },
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: siteColors.hairline,
  },
  heading: { alignSelf: "start", maxWidth: { default: "none", [queries.tabletDown]: "30rem" } },
  content: { minWidth: 0 },
  below: {
    gridColumn: "1 / -1",
    minWidth: 0,
    marginTop: { default: "2.25rem", [queries.tabletDown]: "0.5rem" },
  },
})
