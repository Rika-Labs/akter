import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"
import { siteColors } from "../styles/site-tokens.stylex.ts"

export const banner = stylex.create({
  root: {
    marginTop: { default: "6rem", [queries.phoneDown]: "4rem" },
    paddingBlock: { default: "3.5rem", [queries.phoneDown]: "2.5rem" },
    paddingInline: { default: "3rem", [queries.phoneDown]: "1.5rem" },
    backgroundColor: siteColors.ink,
    color: siteColors.page,
  },
  title: {
    fontSize: { default: "2.5rem", [queries.phoneDown]: "1.875rem" },
    color: siteColors.page,
  },
  body: {
    maxWidth: "29.375rem",
    marginTop: "0.75rem",
    fontSize: "1rem",
    lineHeight: 1.55,
    color: siteColors.inverseSoft,
  },
  action: { marginTop: "1.625rem" },
})
