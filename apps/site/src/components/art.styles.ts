import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"

export const art = stylex.create({
  svg: {
    display: "block",
    width: "100%",
    height: "auto",
    overflow: "hidden",
    strokeLinejoin: "round",
  },
  phoneCrop: {
    width: { default: "100%", [queries.phoneDown]: "183%" },
    marginInlineStart: { default: 0, [queries.phoneDown]: "-42.5%" },
    overflow: "visible",
  },
  clip: { overflow: "hidden" },
})
