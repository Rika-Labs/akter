import { colors, motion, radius, shadows, space } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"
import { siteColors } from "../styles/site-tokens.stylex.ts"

export const panel = stylex.create({
  root: {
    position: "relative",
    minWidth: 0,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    boxShadow: shadows.md,
  },
  padded: { padding: { default: space.xxl, [queries.phoneDown]: space.xl } },
  snug: { padding: { default: space.xl, [queries.phoneDown]: space.lg } },
  clip: { overflow: "hidden" },
  inverse: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
    color: colors.primaryForeground,
  },
  interactive: {
    display: "flex",
    flexDirection: "column",
    borderColor: { default: colors.border, ":hover": colors.borderStrong },
    boxShadow: { default: shadows.md, ":hover": shadows.lg },
    transitionProperty: "box-shadow, border-color",
    transitionDuration: motion.moderate,
  },
  flat: { boxShadow: "none" },
  muted: { backgroundColor: colors.background },
  inverseText: { color: siteColors.inverseSoft },
})
