import { colors, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"

export const wordmark = stylex.create({
  root: {
    display: "inline-flex",
    alignItems: "center",
    color: colors.foreground,
    fontFamily: typography.sans,
    fontWeight: 620,
    lineHeight: 0.9,
  },
  small: { gap: "0.4em", fontSize: "1.1875rem", letterSpacing: "-0.035em" },
  footer: { gap: "0.34em", fontSize: "1.875rem", letterSpacing: "-0.04em" },
  hero: {
    gap: "0.17em",
    fontSize: "clamp(4.5rem, 20vw, 9.75rem)",
    letterSpacing: "-0.048em",
  },
  markSmall: { width: "1.15em", height: "1.15em" },
  markHero: { width: "0.91em", height: "0.91em" },
  word: { display: "block", paddingBottom: "0.05em" },
})
