import {
  colors,
  dimensions,
  motion,
  radius,
  shadows,
  space,
  typography,
} from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"

export const button = stylex.create({
  root: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    height: dimensions.control,
    paddingInline: space.lg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    fontFamily: typography.sans,
    fontSize: typography.small,
    fontWeight: typography.weightMedium,
    lineHeight: 1,
    whiteSpace: "nowrap",
    cursor: "pointer",
    transitionProperty: "background-color, border-color, box-shadow, transform",
    transitionDuration: motion.fast,
    transitionTimingFunction: motion.ease,
    outlineWidth: { default: 0, ":focus-visible": 2 },
    outlineStyle: "solid",
    outlineColor: colors.ring,
    outlineOffset: 2,
  },
  primary: {
    backgroundColor: { default: colors.primary, ":hover": colors.primaryHover },
    color: colors.primaryForeground,
  },
  secondary: {
    backgroundColor: { default: colors.card, ":hover": colors.muted },
    borderColor: colors.borderStrong,
    color: colors.foreground,
    boxShadow: shadows.sm,
  },
  ghost: {
    backgroundColor: { default: "transparent", ":hover": colors.accent },
    color: colors.foreground,
  },
  inverse: {
    backgroundColor: { default: colors.stone, ":hover": colors.card },
    color: colors.primary,
  },
  large: {
    height: dimensions.controlLg,
    paddingInline: space.xl,
    fontSize: typography.body,
  },
  block: { display: "flex", width: "100%" },
})
