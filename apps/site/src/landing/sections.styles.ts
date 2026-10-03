import { colors, radius, shadows, space, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"
import { siteColors } from "../styles/site-tokens.stylex.ts"

export const section = stylex.create({
  block: {
    marginTop: { default: "7rem", [queries.phoneDown]: "5rem" },
    display: "grid",
    gap: { default: space.xxl, [queries.phoneDown]: space.xl },
  },
  center: { justifyItems: "center", textAlign: "center" },
})

export const hero = stylex.create({
  root: { textAlign: "center", paddingTop: "2.5rem", display: "grid", justifyItems: "center" },
  headline: {
    maxWidth: "50rem",
    marginTop: "2.125rem",
    fontSize: { default: typography.displaySm, [queries.phoneDown]: "1.5625rem" },
    lineHeight: 1.25,
    letterSpacing: "-0.012em",
    textWrap: "balance",
  },
  mark: {
    backgroundColor: colors.highlight,
    color: "inherit",
    borderRadius: radius.xs,
    paddingInline: "0.18em",
    boxDecorationBreak: "clone",
  },
  install: { marginTop: "2.125rem", display: "flex", justifyContent: "center", maxWidth: "100%" },
  scene: { marginTop: "1.75rem", width: "100%" },
})

export const actor = stylex.create({
  grid: {
    display: "grid",
    gridTemplateColumns: { default: "1.2fr 1fr", [queries.tabletDown]: "1fr" },
    gap: { default: "3rem", [queries.tabletDown]: space.xxl },
    alignItems: "center",
  },
  copy: { display: "grid", gap: space.md },
  lead: { fontSize: "1.0625rem", lineHeight: 1.55, textWrap: "pretty" },
  legend: {
    display: "grid",
    marginTop: space.md,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  item: {
    display: "grid",
    gridTemplateColumns: "1.875rem 1fr",
    columnGap: space.md,
    paddingBlock: "0.6875rem",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    fontSize: "0.90625rem",
    lineHeight: 1.45,
    color: siteColors.bodyForeground,
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.375rem",
    height: "1.375rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.xs,
    backgroundColor: colors.card,
    fontFamily: typography.mono,
    fontSize: typography.micro,
    color: colors.foreground,
  },
  strong: { fontWeight: typography.weightStrong, color: colors.foreground },
})

export const code = stylex.create({
  grid: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr) minmax(0, 1fr)",
      [queries.tabletDown]: "minmax(0, 1fr)",
    },
    gap: space.lg,
    alignItems: "start",
    width: "100%",
    textAlign: "left",
  },
  column: { display: "grid", gap: space.lg, minWidth: 0 },
  result: { width: "100%", textAlign: "left" },
  resultHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.lg,
    flexWrap: "wrap",
    marginBottom: space.lg,
  },
  resultTitle: {
    fontSize: { default: "1.375rem", [queries.phoneDown]: "1.125rem" },
    lineHeight: 1.2,
  },
  stamp: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: "0.3125rem",
    paddingInline: space.md,
    borderRadius: radius.xs,
    backgroundColor: colors.primary,
    color: colors.primaryForeground,
    fontFamily: typography.mono,
    fontSize: typography.micro,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
  stampDim: { color: siteColors.inverseMuted },
  diagram: { paddingBlock: space.md },
  manifest: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(5, minmax(0, 1fr))",
      [queries.tabletDown]: "repeat(2, minmax(0, 1fr))",
      [queries.phoneDown]: "minmax(0, 1fr)",
    },
    gap: { default: space.xl, [queries.phoneDown]: space.md },
    marginTop: space.xl,
    paddingTop: space.xl,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  field: { display: "grid", gap: space.xs, minWidth: 0 },
  fieldLabel: {
    fontFamily: typography.mono,
    fontSize: typography.micro,
    letterSpacing: typography.trackingMono,
    textTransform: "uppercase",
    color: colors.mutedForeground,
  },
  fieldValue: { fontFamily: typography.mono, fontSize: typography.small, color: colors.foreground },
})

export const useCases = stylex.create({
  grid: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(3, minmax(0, 1fr))",
      [queries.tabletDown]: "minmax(0, 1fr)",
    },
    gap: { default: space.xxl, [queries.tabletDown]: "3rem" },
  },
  item: { display: "flex", flexDirection: "column", textAlign: "center", minWidth: 0 },
  title: { fontSize: { default: "1.5rem", [queries.phoneDown]: "1.375rem" }, lineHeight: 1.15 },
  text: {
    maxWidth: "20rem",
    marginInline: "auto",
    marginBlock: `${space.sm} ${space.xl}`,
    fontSize: "0.90625rem",
    lineHeight: 1.5,
    color: siteColors.bodyForeground,
    textWrap: "pretty",
  },
  art: {
    marginTop: "auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: { default: "18.75rem", [queries.phoneDown]: "15rem" },
    backgroundColor: colors.background,
  },
  svg: { width: "78%", height: "auto", overflow: "visible", opacity: 0.94 },
})

export const proof = stylex.create({
  chartTitle: {
    fontSize: typography.lead,
    fontWeight: typography.weightStrong,
    color: colors.foreground,
  },
  chartLead: { marginTop: space.sm, fontSize: "0.875rem", lineHeight: 1.5 },
  grid: {
    display: "grid",
    gridTemplateColumns: { default: "1.25fr 1fr", [queries.tabletDown]: "minmax(0, 1fr)" },
    gap: space.lg,
    alignItems: "start",
  },
  column: { display: "grid", gap: space.lg, minWidth: 0 },
  figures: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: space.md,
    marginTop: space.lg,
    paddingTop: space.lg,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  note: {
    marginTop: space.lg,
    fontSize: typography.caption,
    lineHeight: 1.55,
    color: colors.mutedForeground,
  },
  link: {
    display: "inline-block",
    marginTop: space.lg,
    fontSize: typography.small,
    textDecorationLine: "underline",
    textUnderlineOffset: "0.25em",
    textDecorationColor: colors.borderStrong,
    color: { default: colors.foreground, ":hover": colors.mutedForeground },
  },
  crashValue: {
    fontFamily: typography.display,
    fontSize: { default: "4.5rem", [queries.phoneDown]: "3.5rem" },
    letterSpacing: "-0.03em",
    lineHeight: 1,
    display: "block",
    fontVariantNumeric: "lining-nums",
  },
  crashUnit: {
    fontSize: typography.lead,
    color: colors.mutedForeground,
    marginInlineStart: space.sm,
    letterSpacing: 0,
  },
  api: { display: "grid", fontFamily: typography.mono, fontSize: "0.78125rem" },
  apiRow: {
    display: "grid",
    gridTemplateColumns: { default: "10.5rem 1fr", [queries.phoneDown]: "8.5rem 1fr" },
    gap: space.md,
    paddingBlock: "0.4375rem",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    ":last-child": { borderBottomWidth: 0 },
  },
  apiDoes: {
    fontFamily: typography.sans,
    fontSize: typography.small,
    color: colors.mutedForeground,
  },
})

export const cta = stylex.create({
  grid: {
    display: "grid",
    gridTemplateColumns: { default: "1fr auto 1fr", [queries.tabletDown]: "minmax(0, 1fr)" },
    gap: space.xl,
    alignItems: "end",
  },
  side: { display: { default: "block", [queries.tabletDown]: "none" } },
  flip: { transform: "scaleX(-1)" },
  middle: {
    display: "grid",
    justifyItems: "center",
    gap: space.md,
    paddingBottom: space.xl,
    textAlign: "center",
  },
  button: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: space.md,
    paddingBlock: "1rem",
    paddingInline: "1.75rem",
    borderRadius: radius.sm,
    backgroundColor: { default: colors.primary, ":hover": colors.primaryHover },
    color: colors.primaryForeground,
    boxShadow: shadows.md,
    fontFamily: typography.display,
    fontSize: { default: "2.125rem", [queries.phoneDown]: "1.75rem" },
    letterSpacing: "-0.02em",
    lineHeight: 1.1,
  },
  buttonNote: {
    fontFamily: typography.sans,
    fontSize: typography.small,
    letterSpacing: 0,
    color: siteColors.inverseMuted,
  },
  text: { maxWidth: "24rem", color: siteColors.bodyForeground, lineHeight: 1.5 },
  docs: {
    fontSize: typography.lead,
    color: colors.foreground,
    textDecorationLine: { default: "none", ":hover": "underline" },
    textUnderlineOffset: "0.25em",
  },
  svg: { width: "100%", height: "auto", display: "block", opacity: 0.94 },
})

export const faq = stylex.create({
  root: { display: "grid", gap: space.lg },
  more: {
    fontSize: typography.small,
    textDecorationLine: "underline",
    textUnderlineOffset: "0.25em",
    textDecorationColor: colors.borderStrong,
    width: "fit-content",
  },
})
