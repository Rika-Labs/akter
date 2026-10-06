import { typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"
import { siteColors } from "../styles/site-tokens.stylex.ts"

export const tiers = stylex.create({
  grid: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(4, minmax(0, 1fr))",
      [queries.tabletDown]: "repeat(2, minmax(0, 1fr))",
      [queries.phoneDown]: "minmax(0, 1fr)",
    },
    gap: "0.75rem",
    marginTop: { default: "3.5rem", [queries.phoneDown]: "2rem" },
  },
  card: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    padding: "1.5rem",
    backgroundColor: siteColors.page,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: siteColors.hairline,
  },
  featured: { borderColor: siteColors.ink, boxShadow: `inset 0 3px 0 ${siteColors.accent}` },
  price: {
    marginTop: "1.375rem",
    fontSize: "2.75rem",
    letterSpacing: "-0.04em",
    lineHeight: 1,
  },
  period: {
    marginInlineStart: "0.25rem",
    fontSize: "0.875rem",
    letterSpacing: 0,
    color: siteColors.muted,
  },
  summary: {
    marginTop: "0.875rem",
    minHeight: { default: "4.125rem", [queries.tabletDown]: 0 },
    fontSize: "0.90625rem",
    lineHeight: 1.5,
    color: "rgb(11 13 11 / 0.65)",
  },
  action: { marginTop: "1.125rem" },
  features: {
    marginTop: "1.375rem",
    paddingTop: "1rem",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: siteColors.hairline,
  },
  feature: {
    display: "flex",
    gap: "0.625rem",
    paddingBlock: "0.3125rem",
    fontSize: "0.875rem",
    "::before": { content: '"—"', color: siteColors.muted },
  },
})

export const usage = stylex.create({
  wrap: { overflowX: "auto" },
  table: { width: "100%", fontSize: "0.9375rem" },
  cell: {
    paddingBlock: "0.875rem",
    paddingInlineEnd: "1rem",
    textAlign: "start",
    fontWeight: 400,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: siteColors.hairline,
  },
  head: {
    fontFamily: typography.mono,
    fontSize: "0.6875rem",
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    color: siteColors.muted,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: siteColors.hairline,
  },
  last: { textAlign: "end", paddingInlineEnd: 0 },
})

export const estimate = stylex.create({
  card: {
    padding: { default: "1.625rem", [queries.phoneDown]: "1.25rem" },
    backgroundColor: siteColors.page,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: siteColors.hairline,
  },
  control: {
    display: "grid",
    gridTemplateColumns: {
      default: "9.375rem minmax(0, 1fr)",
      [queries.phoneDown]: "minmax(0, 1fr)",
    },
    alignItems: "center",
    gap: { default: 0, [queries.phoneDown]: "0.5rem" },
    marginTop: "0.625rem",
    fontSize: "0.84375rem",
    ":first-child": { marginTop: 0 },
  },
  options: {
    display: "grid",
    gridAutoFlow: "column",
    gridAutoColumns: "1fr",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: siteColors.hairline,
  },
  option: {
    paddingBlock: "0.5625rem",
    textAlign: "center",
    color: "rgb(11 13 11 / 0.6)",
    borderInlineStartWidth: 1,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: siteColors.hairline,
    ":first-child": { borderInlineStartWidth: 0 },
  },
  on: { backgroundColor: siteColors.selected, color: siteColors.ink },
  total: {
    marginTop: "2rem",
    fontSize: { default: "4rem", [queries.phoneDown]: "3rem" },
    letterSpacing: "-0.04em",
    lineHeight: 1,
  },
  unit: {
    marginInlineStart: "0.25rem",
    fontSize: "0.9375rem",
    letterSpacing: 0,
    color: siteColors.muted,
  },
})
