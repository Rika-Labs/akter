import { siteColors } from "../styles/site-tokens.stylex.ts"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"

export const scene = stylex.create({
  svg: {
    display: "block",
    width: "100%",
    height: "auto",
    overflow: "visible",
    strokeLinejoin: "round",
  },
  soft: { opacity: 0.94 },
  crop: {
    width: { default: "100%", [queries.phoneDown]: "183%" },
    marginInlineStart: { default: 0, [queries.phoneDown]: "-52.5%" },
  },
  clip: { overflow: "hidden" },
  strokeInk: { color: siteColors.figureStroke },
})
