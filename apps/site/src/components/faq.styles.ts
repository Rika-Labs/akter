import { colors, motion, space, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"
import { siteColors } from "../styles/site-tokens.stylex.ts"

export const faq = stylex.create({
  list: { display: "grid" },
  item: {
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    ":first-child": { borderTopWidth: 1, borderTopStyle: "solid", borderTopColor: colors.border },
  },
  summary: {
    display: "grid",
    gridTemplateColumns: {
      default: "2.75rem 1fr 1.25rem",
      [queries.phoneDown]: "2rem 1fr 1.25rem",
    },
    alignItems: "baseline",
    paddingBlock: space.lg,
    cursor: "pointer",
    fontSize: { default: "0.9375rem", [queries.phoneDown]: "0.875rem" },
    fontWeight: typography.weightMedium,
    color: colors.foreground,
    outlineWidth: { default: 0, ":focus-visible": 2 },
    outlineStyle: "solid",
    outlineColor: colors.ring,
    outlineOffset: -2,
  },
  number: {
    fontFamily: typography.mono,
    fontSize: typography.caption,
    fontWeight: typography.weightRegular,
    color: colors.subtleForeground,
  },
  question: { textWrap: "pretty" },
  icon: {
    justifySelf: "end",
    width: 12,
    height: 12,
    alignSelf: "center",
    color: colors.mutedForeground,
    transitionProperty: "transform",
    transitionDuration: motion.moderate,
    transitionTimingFunction: motion.ease,
  },
  iconOpen: {},
  answer: {
    paddingBottom: space.xl,
    paddingInlineStart: { default: "2.75rem", [queries.phoneDown]: "2rem" },
    paddingInlineEnd: space.xl,
    maxWidth: "46rem",
    fontSize: typography.body,
    lineHeight: 1.65,
    color: siteColors.bodyForeground,
  },
})
