import { typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { siteColors } from "../styles/site-tokens.stylex.ts"

export const wordmark = stylex.create({
  root: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.5625rem",
    fontFamily: typography.sans,
    fontSize: "1.1875rem",
    fontWeight: 600,
    letterSpacing: "-0.025em",
    lineHeight: 1,
  },
  mark: { color: siteColors.mark },
})
