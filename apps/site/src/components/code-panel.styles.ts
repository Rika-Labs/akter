import { colors, radius, shadows, space, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"
import { siteColors } from "../styles/site-tokens.stylex.ts"

export const codePanel = stylex.create({
  root: {
    minWidth: 0,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    boxShadow: shadows.md,
    paddingBlock: space.lg,
    paddingInline: { default: space.xl, [queries.phoneDown]: space.md },
  },
  bare: { boxShadow: "none" },
  head: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.lg,
    paddingBottom: space.md,
    marginBottom: space.md,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    fontSize: "0.78125rem",
    color: colors.mutedForeground,
  },
  title: { fontWeight: typography.weightMedium },
  file: {
    fontFamily: typography.mono,
    fontSize: typography.caption,
    color: colors.mutedForeground,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  body: {
    marginBlock: 0,
    marginInline: { default: "-0.375rem", [queries.phoneDown]: 0 },
    padding: { default: "0.875rem 1rem", [queries.phoneDown]: "0.75rem" },
    borderRadius: radius.sm,
    backgroundColor: colors.code,
    overflowX: "auto",
    fontFamily: typography.mono,
    fontSize: { default: "0.78125rem", [queries.phoneDown]: "0.6875rem" },
    lineHeight: 1.75,
    tabSize: 2,
    color: siteColors.bodyForeground,
  },
  code: { fontFamily: "inherit", whiteSpace: "pre", display: "block" },
  wrap: {
    whiteSpace: { default: "pre-wrap", [queries.phoneDown]: "pre" },
    overflowWrap: { default: "anywhere", [queries.phoneDown]: "normal" },
  },
})
