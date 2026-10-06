import * as stylex from "@stylexjs/stylex"
import { siteColors } from "../styles/site-tokens.stylex.ts"

export const chip = stylex.create({
  root: {
    display: "inline-flex",
    alignItems: "stretch",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: siteColors.hairline,
    backgroundColor: siteColors.tile,
    fontSize: "0.8125rem",
    lineHeight: "normal",
    maxWidth: "100%",
  },
  part: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    paddingBlock: "0.375rem",
    paddingInline: "0.75rem",
    color: siteColors.soft,
  },
  action: {
    backgroundColor: siteColors.page,
    borderInlineStartWidth: 1,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: siteColors.hairline,
    color: siteColors.ink,
    fontWeight: 500,
  },
  dot: {
    width: 6,
    height: 6,
    backgroundColor: siteColors.accent,
    borderRadius: "50%",
    flexShrink: 0,
  },
})
