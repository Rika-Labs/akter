import { colors, radius, shadows, space, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"
import { siteColors } from "../styles/site-tokens.stylex.ts"

export const strip = stylex.create({
  root: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(4, minmax(0, 1fr))",
      [queries.phoneDown]: "repeat(2, minmax(0, 1fr))",
    },
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    boxShadow: shadows.md,
    overflow: "hidden",
  },
  cell: {
    padding: { default: `${space.xl} ${space.xl}`, [queries.phoneDown]: space.lg },
    borderInlineStartWidth: 1,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: colors.border,
    ":first-child": { borderInlineStartWidth: 0 },
  },
  second: {
    borderTopWidth: { default: 0, [queries.phoneDown]: 1 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  oddStart: { borderInlineStartWidth: { default: 1, [queries.phoneDown]: 0 } },
})

export const setup = stylex.create({
  root: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(3, minmax(0, 1fr))",
      [queries.tabletDown]: "minmax(0, 1fr)",
    },
    gap: { default: space.xl, [queries.tabletDown]: 0 },
    marginTop: space.lg,
    fontSize: typography.small,
    lineHeight: 1.55,
    color: siteColors.bodyForeground,
  },
  item: {
    paddingBlock: space.md,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  strong: { fontWeight: typography.weightStrong, color: colors.foreground },
  key: {
    marginTop: space.md,
    fontSize: typography.caption,
    color: colors.mutedForeground,
    lineHeight: 1.55,
  },
})

export const cases = stylex.create({
  root: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      [queries.tabletDown]: "minmax(0, 1fr)",
    },
    gap: space.lg,
    marginTop: { default: "3.5rem", [queries.phoneDown]: "2.5rem" },
  },
})

export const crash = stylex.create({
  root: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr) minmax(0, 1.3fr)",
      [queries.tabletDown]: "minmax(0, 1fr)",
    },
    marginTop: space.lg,
  },
  summary: { padding: { default: space.xxl, [queries.phoneDown]: space.xl } },
  ledger: {
    padding: { default: space.xl, [queries.phoneDown]: space.lg },
    borderInlineStartWidth: { default: 1, [queries.tabletDown]: 0 },
    borderInlineStartStyle: "solid",
    borderInlineStartColor: colors.border,
    borderTopWidth: { default: 0, [queries.tabletDown]: 1 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    overflowX: "auto",
  },
  big: {
    display: "block",
    fontFamily: typography.display,
    fontSize: { default: "4.75rem", [queries.phoneDown]: "3.25rem" },
    letterSpacing: "-0.03em",
    lineHeight: 1,
    fontVariantNumeric: "lining-nums",
  },
  caption: { marginTop: space.sm, color: colors.mutedForeground, fontSize: typography.lead },
  zeros: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: space.md,
    marginTop: space.xl,
    paddingTop: space.lg,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  note: {
    marginTop: space.lg,
    fontSize: typography.small,
    lineHeight: 1.55,
    color: colors.mutedForeground,
  },
  table: {
    width: "100%",
    minWidth: "30rem",
    borderCollapse: "collapse",
    fontFamily: typography.mono,
    fontSize: typography.caption,
  },
  th: {
    paddingBlock: space.sm,
    paddingInline: space.sm,
    textAlign: "start",
    fontWeight: typography.weightRegular,
    fontSize: typography.micro,
    letterSpacing: typography.trackingMono,
    textTransform: "uppercase",
    color: colors.mutedForeground,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    whiteSpace: "nowrap",
  },
  td: {
    paddingBlock: space.sm,
    paddingInline: space.sm,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    color: colors.mutedForeground,
    whiteSpace: "nowrap",
  },
  tdFinal: { color: colors.foreground, fontWeight: typography.weightMedium },
  num: { textAlign: "end", fontVariantNumeric: "tabular-nums" },
  ack: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: space.sm },
  tick: { width: "3.5rem", height: "0.375rem", flexShrink: 0 },
  tickBar: { fill: colors.chartMuted },
  tickFinal: { fill: colors.chartLine },
  flagged: { color: colors.warning },
})

export const limits = stylex.create({
  root: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      [queries.tabletDown]: "minmax(0, 1fr)",
    },
    gap: space.lg,
    marginTop: space.lg,
  },
  title: { fontSize: "1.5rem" },
  list: {
    display: "grid",
    gap: space.md,
    marginTop: space.lg,
    paddingInlineStart: "1.125rem",
    listStyleType: "disc",
    fontSize: typography.body,
    lineHeight: 1.6,
    color: siteColors.bodyForeground,
  },
  actions: { display: "flex", flexWrap: "wrap", gap: space.sm, marginTop: space.xl },
})
