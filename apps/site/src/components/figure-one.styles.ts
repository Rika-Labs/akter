import { typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { siteColors } from "../styles/site-tokens.stylex.ts"

export const figureOne = stylex.create({
  box: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: siteColors.hairline,
    backgroundColor: siteColors.page,
    backgroundImage: `radial-gradient(${siteColors.dot} 1px, transparent 1.2px)`,
    backgroundSize: "16px 16px",
  },
  svg: {
    display: "block",
    width: "100%",
    height: "auto",
    fontFamily: typography.mono,
    color: siteColors.ink,
  },
  tile: { fill: siteColors.tile, stroke: siteColors.hairline },
  page: { fill: siteColors.page },
  ink: { fill: siteColors.ink },
  mark: { stroke: siteColors.page },
  caption: {
    marginTop: "0.75rem",
    fontSize: "0.875rem",
    lineHeight: 1.5,
    color: siteColors.muted,
  },
})
