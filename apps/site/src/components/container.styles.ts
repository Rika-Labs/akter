import { dimensions, space } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"
import { siteDimensions } from "../styles/site-tokens.stylex.ts"

export const container = stylex.create({
  root: {
    width: "100%",
    maxWidth: dimensions.siteColumn,
    marginInline: "auto",
    paddingInline: { default: space.xxxl, [queries.phoneDown]: space.xl },
  },
  landing: { maxWidth: siteDimensions.landingColumn },
  reading: { maxWidth: dimensions.readingColumn },
})
