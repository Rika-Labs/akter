import { colors, motion, space, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"
import { siteColors } from "../styles/site-tokens.stylex.ts"

const grow = stylex.keyframes({
  from: { transform: "scaleX(0)" },
  to: { transform: "scaleX(1)" },
})

export const bars = stylex.create({
  root: { display: "grid", gap: space.md, minWidth: 0 },
  title: { fontSize: { default: "1.625rem", [queries.phoneDown]: "1.375rem" } },
  lead: { fontSize: typography.small, color: colors.mutedForeground, lineHeight: 1.5 },
  chart: { display: "grid", marginTop: space.md },
  row: {
    display: "grid",
    gridTemplateColumns: {
      default: "7.5rem minmax(0, 1fr) 5.75rem",
      [queries.phoneDown]: "minmax(0, 1fr) auto",
    },
    gridTemplateAreas: {
      default: '"name plot value"',
      [queries.phoneDown]: '"name value" "plot plot"',
    },
    columnGap: space.md,
    alignItems: "center",
    paddingBlock: { default: 0, [queries.phoneDown]: "0.1875rem" },
  },
  name: {
    gridArea: "name",
    fontSize: typography.small,
    color: siteColors.bodyForeground,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    height: "1.75rem",
    display: "flex",
    alignItems: "center",
  },
  us: { fontWeight: typography.weightStrong, color: colors.foreground },
  uncollected: { color: colors.subtleForeground },
  plot: {
    gridArea: "plot",
    display: "block",
    width: "100%",
    height: { default: "1.75rem", [queries.phoneDown]: "1.375rem" },
    overflow: "visible",
  },
  value: {
    gridArea: "value",
    fontFamily: typography.mono,
    fontSize: typography.caption,
    textAlign: "right",
    whiteSpace: "nowrap",
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  valueUs: { color: colors.foreground, fontWeight: typography.weightMedium },
  grid: { stroke: colors.chartGrid },
  gridBase: { stroke: colors.chartMuted },
  barUs: { fill: colors.chartLine },
  barOther: { fill: colors.chartMuted },
  range: { stroke: colors.subtleForeground, strokeWidth: 1 },
  rangeFill: { fill: colors.subtleForeground },
  missing: { stroke: colors.chartMuted, strokeDasharray: "2 3" },
  bar: {
    transformOrigin: "left center",
    transformBox: "fill-box",
    animationName: { default: "none", [queries.motionOk]: grow },
    animationDuration: "800ms",
    animationTimingFunction: motion.easeOut,
    animationFillMode: "both",
  },
  ticks: {
    display: "grid",
    gridTemplateColumns: {
      default: "7.5rem minmax(0, 1fr) 5.75rem",
      [queries.phoneDown]: "minmax(0, 1fr)",
    },
    columnGap: space.md,
  },
  tickPlot: {
    gridColumn: { default: "2", [queries.phoneDown]: "1" },
    display: "block",
    width: "100%",
    height: "1.25rem",
    overflow: "visible",
  },
  tickLabel: {
    fill: colors.subtleForeground,
    fontFamily: typography.mono,
    fontSize: 10,
  },
  baseline: {
    display: "flex",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: space.md,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    fontSize: typography.caption,
    color: colors.mutedForeground,
  },
  baselineValue: { fontFamily: typography.mono, textAlign: "right" },
  footnote: { fontSize: typography.caption, color: colors.mutedForeground, lineHeight: 1.5 },
})
