import { colors, motion, space, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"

export const footer = stylex.create({
  root: { marginTop: space.chapter },
  compact: {
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    paddingBlock: space.xxl,
    display: "flex",
    justifyContent: "space-between",
    gap: space.xl,
    flexDirection: { default: "row", [queries.phoneDown]: "column" },
    alignItems: { default: "center", [queries.phoneDown]: "flex-start" },
  },
  full: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(3, 7.5rem) 1fr",
      [queries.phoneDown]: "repeat(3, minmax(0, 1fr))",
    },
    gap: space.xl,
    fontSize: typography.small,
  },
  column: { display: "grid", alignContent: "start", gap: space.md },
  heading: {
    fontSize: typography.small,
    fontWeight: typography.weightStrong,
    color: colors.foreground,
  },
  link: {
    color: { default: colors.mutedForeground, ":hover": colors.foreground },
    transitionProperty: "color",
    transitionDuration: motion.fast,
  },
  inline: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.xl,
    fontSize: typography.caption,
  },
  brand: {
    justifySelf: { default: "end", [queries.phoneDown]: "start" },
    gridColumn: { default: "auto", [queries.phoneDown]: "1 / -1" },
    alignSelf: "start",
    display: "inline-flex",
  },
  strip: { marginTop: space.xxl, opacity: 0.82 },
  stripSvg: { width: "100%", height: "auto" },
})
