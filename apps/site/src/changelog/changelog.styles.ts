import { typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"
import { siteColors, siteDimensions } from "../styles/site-tokens.stylex.ts"

export const changelog = stylex.create({
  intro: { paddingBottom: { default: "3.5rem", [queries.phoneDown]: "2rem" } },
  entry: {
    display: "grid",
    gridTemplateColumns: {
      default: "13.75rem minmax(0, 1fr)",
      [queries.tabletDown]: "minmax(0, 1fr)",
    },
    columnGap: "3.75rem",
    rowGap: "1rem",
    paddingBlock: { default: "3rem", [queries.phoneDown]: "2rem" },
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: siteColors.hairline,
  },
  when: {
    position: { default: "sticky", [queries.tabletDown]: "static" },
    top: `calc(${siteDimensions.headerHeight} + 1.75rem)`,
    alignSelf: "start",
  },
  date: { fontSize: "0.875rem" },
  version: { marginTop: "0.375rem" },
  title: { fontSize: { default: "1.875rem", [queries.phoneDown]: "1.5rem" } },
  summary: { marginTop: "0.875rem", maxWidth: "40rem" },
  art: {
    marginTop: "1.75rem",
    paddingTop: "1.75rem",
    paddingInline: { default: "1.5rem", [queries.phoneDown]: "0.75rem" },
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: siteColors.hairline,
    overflow: "hidden",
  },
  group: {
    marginTop: "1.75rem",
    fontFamily: typography.mono,
    fontWeight: 400,
    fontSize: "0.6875rem",
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    color: siteColors.muted,
  },
  list: { marginTop: "0.625rem", maxWidth: "40rem" },
  item: {
    display: "flex",
    gap: "0.625rem",
    paddingBlock: "0.375rem",
    fontSize: "0.9375rem",
    lineHeight: 1.5,
    color: "rgb(11 13 11 / 0.75)",
    "::before": { content: '"—"', color: siteColors.muted },
  },
})
