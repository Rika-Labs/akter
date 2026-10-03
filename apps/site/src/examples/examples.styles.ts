import { colors, motion, radius, space, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"
import { siteColors } from "../styles/site-tokens.stylex.ts"

export const filters = stylex.create({
  root: { display: "flex", flexWrap: "wrap", gap: space.sm, marginBottom: space.xl },
  chip: {
    height: "1.875rem",
    paddingInline: space.md,
    borderRadius: radius.xs,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: colors.card, ":hover": colors.muted },
    fontSize: typography.small,
    color: siteColors.bodyForeground,
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: motion.fast,
  },
  on: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
    color: colors.primaryForeground,
  },
})

export const featured = stylex.create({
  root: {
    display: "grid",
    gridTemplateColumns: { default: "1fr 1.05fr", [queries.tabletDown]: "minmax(0, 1fr)" },
  },
  art: {
    display: "flex",
    alignItems: "flex-end",
    padding: { default: "1.625rem 1.25rem 0", [queries.phoneDown]: "1.25rem 0.75rem 0" },
    backgroundColor: colors.background,
    borderInlineEndWidth: { default: 1, [queries.tabletDown]: 0 },
    borderInlineEndStyle: "solid",
    borderInlineEndColor: colors.border,
    borderBottomWidth: { default: 0, [queries.tabletDown]: 1 },
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
  svg: { width: "100%", height: "auto", overflow: "visible", opacity: 0.94 },
  body: { padding: { default: space.xxl, [queries.phoneDown]: space.xl }, minWidth: 0 },
  title: {
    marginTop: space.md,
    fontSize: { default: "2.375rem", [queries.phoneDown]: "1.875rem" },
  },
  text: { marginTop: space.md, fontSize: typography.lead, lineHeight: 1.55 },
  code: {
    marginTop: space.lg,
    paddingTop: space.lg,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    fontFamily: typography.mono,
    fontSize: { default: "0.78125rem", [queries.phoneDown]: "0.6875rem" },
    lineHeight: 1.75,
    overflowX: "auto",
    color: siteColors.bodyForeground,
  },
  link: {
    display: "inline-block",
    marginTop: space.lg,
    fontSize: typography.small,
    textDecorationLine: "underline",
    textUnderlineOffset: "0.25em",
    textDecorationColor: colors.borderStrong,
  },
})

export const grid = stylex.create({
  root: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(3, minmax(0, 1fr))",
      [queries.tabletDown]: "repeat(2, minmax(0, 1fr))",
      [queries.phoneDown]: "minmax(0, 1fr)",
    },
    gap: space.xl,
    marginTop: space.xl,
  },
  art: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "11.875rem",
    backgroundColor: colors.background,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
  svg: { width: "82%", height: "auto", overflow: "visible", opacity: 0.94 },
  body: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    padding: `${space.xl} ${space.xl} ${space.xl}`,
  },
  title: { marginTop: space.md, fontSize: "1.625rem" },
  text: {
    marginTop: space.sm,
    fontSize: typography.body,
    lineHeight: 1.55,
    color: siteColors.bodyForeground,
  },
})

export const status = stylex.create({
  root: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.sm,
    fontFamily: typography.mono,
    fontSize: typography.micro,
    letterSpacing: typography.trackingMono,
    textTransform: "uppercase",
    color: colors.mutedForeground,
  },
  live: { color: colors.foreground },
  dot: {
    width: "0.4375rem",
    height: "0.4375rem",
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.foreground,
    backgroundColor: colors.foreground,
  },
  planned: { backgroundColor: "transparent", borderColor: colors.subtleForeground },
})
