import { typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"
import { siteColors } from "../styles/site-tokens.stylex.ts"

export const hero = stylex.create({
  root: { paddingTop: { default: "6.5rem", [queries.phoneDown]: "3.5rem" } },
  title: { maxWidth: "58.75rem", marginTop: "1.875rem" },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.75rem",
    marginTop: { default: "2.125rem", [queries.phoneDown]: "1.75rem" },
  },
  art: { marginTop: { default: "4.5rem", [queries.phoneDown]: "2.5rem" } },
})

export const prose = stylex.create({
  paragraph: {
    fontSize: { default: "1.0625rem", [queries.phoneDown]: "1rem" },
    lineHeight: 1.72,
    color: siteColors.prose,
    marginTop: "1.375rem",
    ":first-child": { marginTop: 0 },
  },
  lead: {
    color: siteColors.ink,
    fontWeight: 500,
    textDecorationLine: "underline",
    textDecorationStyle: "dotted",
    textDecorationColor: siteColors.accent,
    textDecorationThickness: "2px",
    textUnderlineOffset: "0.25rem",
  },
  strong: { fontWeight: 600, color: siteColors.ink },
  figure: { marginTop: "2.5rem" },
})

export const builds = stylex.create({
  row: {
    display: "grid",
    gridTemplateColumns: {
      default: "5.25rem minmax(0, 1fr)",
      [queries.phoneDown]: "4rem minmax(0, 1fr)",
    },
    gap: { default: "1.5rem", [queries.phoneDown]: "1rem" },
    marginBottom: "2rem",
  },
  thumb: {
    display: "grid",
    placeItems: "center",
    width: { default: "5.25rem", [queries.phoneDown]: "4rem" },
    height: { default: "5.25rem", [queries.phoneDown]: "4rem" },
    padding: "0.375rem",
    overflow: "hidden",
    backgroundColor: siteColors.tile,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: siteColors.ink,
  },
  text: { marginTop: "0.25rem" },
})

export const proof = stylex.create({
  root: {
    marginTop: { default: "6rem", [queries.phoneDown]: "4rem" },
    paddingTop: { default: "2.5rem", [queries.phoneDown]: "1.75rem" },
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: siteColors.hairline,
  },
  promise: {
    maxWidth: "56.25rem",
    fontSize: { default: "2.375rem", [queries.phoneDown]: "1.625rem" },
    lineHeight: 1.22,
    letterSpacing: "-0.025em",
    fontWeight: 450,
    color: "rgb(11 13 11 / 0.42)",
  },
  emphasis: { color: siteColors.ink, fontWeight: 450 },
  title: { fontSize: "0.96875rem" },
  label: { fontSize: "0.65625rem", marginTop: "0.25rem" },
  grid: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      [queries.tabletDown]: "minmax(0, 1fr)",
    },
    gap: "0.75rem",
    marginTop: "2.25rem",
  },
  stack: { display: "grid", gap: "0.75rem", alignContent: "start" },
  card: {
    minWidth: 0,
    padding: "1.375rem",
    backgroundColor: siteColors.page,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: siteColors.hairline,
  },
  figure: {
    marginTop: "1.375rem",
    fontSize: { default: "3rem", [queries.phoneDown]: "2.5rem" },
    fontWeight: 400,
    letterSpacing: "-0.04em",
    lineHeight: 1,
  },
  unit: {
    marginInlineStart: "0.25rem",
    fontSize: "0.9375rem",
    letterSpacing: 0,
    color: siteColors.muted,
  },
  trio: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    marginTop: "1.375rem",
    paddingTop: "1rem",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: siteColors.hairline,
    fontSize: "1.625rem",
    letterSpacing: "-0.02em",
  },
  trioLabel: { display: "block", marginTop: "0.25rem", fontSize: "0.65625rem" },
  latency: {
    display: "grid",
    gridTemplateColumns: "6.875rem minmax(0, 1fr)",
    alignItems: "baseline",
    rowGap: "0.625rem",
    marginTop: "1.25rem",
  },
  latencyLabel: {
    fontFamily: typography.mono,
    fontSize: "0.6875rem",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
  },
  latencyValue: { fontSize: "2.125rem", letterSpacing: "-0.03em" },
  bars: {
    display: "flex",
    alignItems: "flex-end",
    gap: "0.625rem",
    height: "11.875rem",
    marginTop: "1.625rem",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: siteColors.hairline,
    backgroundImage: `linear-gradient(${siteColors.hairline} 1px, transparent 1px)`,
    backgroundSize: "100% 25%",
  },
  bar: { flex: 1, backgroundColor: siteColors.bar },
  barAkter: { backgroundColor: siteColors.accent },
  barLabels: { display: "flex", gap: "0.625rem", marginTop: "0.5rem" },
  barLabel: {
    flex: 1,
    minWidth: 0,
    fontFamily: typography.mono,
    fontSize: { default: "0.59375rem", [queries.phoneDown]: "0.5rem" },
    color: siteColors.muted,
    textAlign: "center",
    overflowWrap: "anywhere",
  },
  barLabelAkter: { color: siteColors.ink },
  report: { marginTop: "1.125rem" },
  reportLink: { fontSize: "0.84375rem" },
  arrow: { marginInlineStart: "0.3125rem" },
})

export const where = stylex.create({
  grid: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(3, minmax(0, 1fr))",
      [queries.tabletDown]: "minmax(0, 1fr)",
    },
    gap: "0.75rem",
  },
  card: {
    minWidth: 0,
    padding: "1rem 1rem 0",
    backgroundColor: siteColors.page,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: siteColors.hairline,
  },
  top: { display: "flex", justifyContent: "space-between", alignItems: "baseline" },
  number: { fontFamily: typography.mono, fontSize: "0.6875rem", color: siteColors.muted },
  text: {
    marginTop: "0.5rem",
    minHeight: { default: "3rem", [queries.tabletDown]: 0 },
    fontSize: "0.875rem",
    lineHeight: 1.5,
    color: "rgb(11 13 11 / 0.62)",
  },
  pic: {
    display: "grid",
    alignContent: "end",
    justifyItems: "center",
    marginInline: "-1rem",
    marginTop: "0.875rem",
    height: "12.5rem",
    paddingTop: "1.125rem",
    paddingInline: "1rem",
    overflow: "hidden",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: siteColors.hairline,
  },
  art: { height: "10.625rem", width: "auto", maxWidth: "100%" },
})
