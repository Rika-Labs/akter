import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"
import { siteDimensions } from "../styles/site-tokens.stylex.ts"

export const container = stylex.create({
  root: {
    boxSizing: "border-box",
    width: "100%",
    maxWidth: `calc(${siteDimensions.column} + 2 * ${siteDimensions.gutter})`,
    marginInline: "auto",
    paddingInline: { default: siteDimensions.gutter, [queries.phoneDown]: "1.25rem" },
  },
})
