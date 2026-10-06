import { typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { siteColors } from "../styles/site-tokens.stylex.ts"

export const button = stylex.create({
  root: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    height: "2.75rem",
    fontFamily: typography.mono,
    fontSize: "0.78125rem",
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
    borderWidth: 1,
    borderStyle: "solid",
    outlineWidth: { default: 0, ":focus-visible": 2 },
    outlineStyle: "solid",
    outlineColor: siteColors.ring,
    outlineOffset: 3,
  },
  small: { height: "2.125rem", paddingInline: "0.875rem", fontSize: "0.75rem" },
  block: { display: "flex", width: "100%" },
  primary: {
    backgroundColor: siteColors.accent,
    color: siteColors.accentInk,
    borderColor: siteColors.accent,
    paddingInline: "1rem",
  },
  tiled: { paddingInlineStart: 0 },
  accent: {
    backgroundColor: siteColors.accent,
    color: siteColors.accentInk,
    borderColor: siteColors.accent,
  },
  inverse: {
    backgroundColor: siteColors.page,
    color: siteColors.ink,
    borderColor: siteColors.page,
  },
  ghost: {
    backgroundColor: { default: siteColors.page, ":hover": siteColors.tile },
    color: siteColors.ink,
    borderColor: siteColors.hairline,
    paddingInline: "1rem",
  },
  tile: {
    display: "grid",
    placeItems: "center",
    width: "2.625rem",
    height: "2.625rem",
    marginInlineEnd: "0.875rem",
    backgroundColor: siteColors.page,
    color: siteColors.ink,
  },
  tileInverse: { backgroundColor: siteColors.accent, color: siteColors.markOnAccent },
  icon: { marginInlineStart: "0.4375rem" },
})
