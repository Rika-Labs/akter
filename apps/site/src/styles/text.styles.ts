import { colors, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { siteColors } from "./site-tokens.stylex.ts"

/** Type styles every page composes: display headings, body copy, mono labels. */
export const text = stylex.create({
  display: {
    fontFamily: typography.display,
    fontWeight: 400,
    letterSpacing: typography.trackingDisplay,
    lineHeight: 1.08,
    color: colors.foreground,
  },
  body: {
    fontFamily: typography.sans,
    fontWeight: typography.weightRegular,
    color: siteColors.bodyForeground,
    lineHeight: 1.6,
  },
  muted: {
    color: colors.mutedForeground,
  },
  mono: {
    fontFamily: typography.mono,
    letterSpacing: "0.01em",
  },
  label: {
    fontFamily: typography.mono,
    fontSize: typography.micro,
    letterSpacing: typography.trackingMono,
    textTransform: "uppercase",
    color: colors.mutedForeground,
  },
  numeric: {
    fontVariantNumeric: "tabular-nums",
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
