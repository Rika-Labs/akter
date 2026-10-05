import * as stylex from "@stylexjs/stylex"
import { queries } from "./breakpoints.stylex.ts"

/** The title block every inner page opens with: a page heading and a one-line lede. */
export const page = stylex.create({
  intro: { paddingTop: { default: "6rem", [queries.phoneDown]: "3rem" } },
})
