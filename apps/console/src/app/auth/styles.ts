import {
  borders,
  colors,
  conditions,
  dimensions,
  radius,
  space,
  typography,
} from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"

/** The signed-out screens: one narrow centred column with the mark above a short form. */
export const authStyles = stylex.create({
  page: {
    display: "grid",
    placeItems: { default: "center", [conditions.compact]: "start center" },
    minHeight: "100dvh",
    paddingBlock: { default: space.xxxl, [conditions.compact]: space.xxl },
    paddingInline: space.lg,
    backgroundColor: colors.frame,
  },
  column: { display: "grid", gap: "0.625rem", width: "100%", maxWidth: dimensions.authColumn },
  wide: { maxWidth: "32rem" },
  title: {
    marginBlock: `1.125rem ${space.sm}`,
    fontSize: typography.heading,
    fontWeight: typography.weightStrong,
    letterSpacing: "-0.3px",
    lineHeight: typography.leadingTight,
  },
  lead: {
    marginBlockEnd: space.sm,
    color: colors.mutedForeground,
    lineHeight: typography.leadingNormal,
  },
  strong: { color: colors.foreground, fontWeight: typography.weightMedium },
  form: { display: "grid", gap: space.md },
  divider: {
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
    marginBlock: space.xs,
    color: colors.subtleForeground,
    fontSize: typography.caption,
    "::before": {
      content: "''",
      flex: "1",
      borderBlockStartWidth: borders.hairline,
      borderBlockStartStyle: "solid",
      borderBlockStartColor: colors.border,
    },
    "::after": {
      content: "''",
      flex: "1",
      borderBlockStartWidth: borders.hairline,
      borderBlockStartStyle: "solid",
      borderBlockStartColor: colors.border,
    },
  },
  error: {
    color: colors.destructive,
    fontSize: typography.small,
    lineHeight: typography.leadingNormal,
  },
  foot: {
    marginBlockStart: "0.625rem",
    color: colors.subtleForeground,
    fontSize: typography.small,
    textAlign: "center",
  },
  link: {
    color: { default: colors.mutedForeground, ":hover": colors.foreground },
    textDecoration: "none",
    textUnderlineOffset: "3px",
    textDecorationLine: { default: "none", ":hover": "underline" },
  },
  inline: { color: colors.foreground, textDecorationLine: "underline", textUnderlineOffset: "3px" },
  art: { width: "11rem", marginInline: "auto", marginBlockEnd: space.sm },
  steps: { display: "flex", gap: space.xs, marginBlockEnd: space.xs },
  step: { flex: "1", height: "3px", borderRadius: radius.full, backgroundColor: colors.border },
  stepDone: { backgroundColor: colors.foreground },
  stepLabel: { color: colors.subtleForeground, fontSize: typography.caption },
  row: {
    display: "flex",
    justifyContent: "space-between",
    gap: space.sm,
    marginBlockStart: space.sm,
  },
  organization: { display: "flex", alignItems: "center", gap: space.md },
  note: {
    color: colors.mutedForeground,
    fontSize: typography.small,
    lineHeight: typography.leadingNormal,
  },
  region: {
    display: "grid",
    gap: space.xxs,
    paddingBlock: space.md,
    paddingInline: space.md,
    textAlign: "start",
  },
  regionId: {
    fontFamily: typography.mono,
    fontSize: typography.caption,
    color: colors.mutedForeground,
  },
  regionPlace: { color: colors.foreground, fontSize: "0.9375rem" },
})

/** The device page's code, set large so it can be compared with the terminal at a glance. */
export const deviceStyles = stylex.create({
  prompt: {
    marginBlockStart: space.sm,
    color: colors.mutedForeground,
    fontSize: typography.small,
    lineHeight: typography.leadingNormal,
  },
  code: {
    paddingBlock: space.lg,
    borderWidth: borders.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
    fontFamily: typography.mono,
    fontSize: typography.title,
    fontWeight: typography.weightMedium,
    letterSpacing: "0.12em",
    textAlign: "center",
  },
  details: {
    display: "grid",
    gridTemplateColumns: "max-content 1fr",
    gap: `${space.sm} ${space.lg}`,
    marginBlock: space.sm,
    fontSize: typography.small,
    lineHeight: typography.leadingNormal,
  },
  term: { color: colors.mutedForeground },
  detail: { margin: 0, color: colors.foreground, overflowWrap: "anywhere" },
  email: { display: "block", color: colors.mutedForeground },
})

/** Placement for full-width controls in the auth column. */
export const authLayout = stylex.create({ fill: { width: "100%" } })
