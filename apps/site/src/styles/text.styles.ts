import { typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "./breakpoints.stylex.ts"
import { siteColors } from "./site-tokens.stylex.ts"

/** Type styles every page composes: headings, body copy and the mono labels. */
export const text = stylex.create({
  hero: {
    fontFamily: typography.sans,
    fontWeight: 450,
    fontSize: { default: "3.75rem", [queries.tabletDown]: "3rem", [queries.phoneDown]: "2.25rem" },
    lineHeight: 1.04,
    letterSpacing: "-0.04em",
    color: siteColors.ink,
    textWrap: "balance",
  },
  page: {
    fontSize: { default: "3.25rem", [queries.phoneDown]: "2.5rem" },
  },
  section: {
    fontFamily: typography.sans,
    fontWeight: 450,
    fontSize: "1.75rem",
    lineHeight: 1.2,
    letterSpacing: "-0.02em",
    color: siteColors.ink,
  },
  title: {
    fontFamily: typography.sans,
    fontWeight: 500,
    fontSize: "1.0625rem",
    letterSpacing: "-0.01em",
    lineHeight: "normal",
    color: siteColors.ink,
  },
  lede: {
    fontSize: { default: "1.1875rem", [queries.phoneDown]: "1.0625rem" },
    color: siteColors.nav,
    marginTop: "1.125rem",
    maxWidth: "38.75rem",
    lineHeight: 1.5,
  },
  body: {
    fontSize: { default: "1.03125rem", [queries.phoneDown]: "1rem" },
    lineHeight: 1.65,
    color: siteColors.soft,
  },
  label: {
    fontFamily: typography.mono,
    fontSize: "0.6875rem",
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    color: siteColors.muted,
    lineHeight: 1.4,
  },
  note: {
    fontSize: "0.8125rem",
    color: siteColors.muted,
    marginTop: "0.875rem",
    lineHeight: 1.6,
  },
  link: {
    display: "inline-flex",
    alignItems: "center",
    fontSize: "0.9375rem",
    fontWeight: 500,
    color: siteColors.ink,
  },
  hidden: {
    position: "absolute",
    width: 1,
    height: 1,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
  },
})
