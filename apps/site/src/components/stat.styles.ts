import { colors, space, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"

export const stat = stylex.create({
  root: { display: "grid", gap: space.sm, alignContent: "start", minWidth: 0 },
  label: {
    fontFamily: typography.mono,
    fontSize: typography.micro,
    letterSpacing: typography.trackingMono,
    textTransform: "uppercase",
    color: colors.mutedForeground,
  },
  value: {
    fontFamily: typography.display,
    fontWeight: 400,
    fontSize: { default: "2.75rem", [queries.phoneDown]: "2.125rem" },
    letterSpacing: "-0.03em",
    lineHeight: 1,
    color: colors.foreground,
    fontVariantNumeric: "lining-nums",
  },
  caption: { fontSize: typography.small, color: colors.mutedForeground, lineHeight: 1.4 },
  mono: {
    fontFamily: typography.mono,
    fontWeight: typography.weightMedium,
    letterSpacing: 0,
    fontSize: { default: "1.375rem", [queries.phoneDown]: "1.125rem" },
  },
})
