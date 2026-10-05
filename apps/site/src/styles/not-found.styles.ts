import * as stylex from "@stylexjs/stylex"
import { queries } from "./breakpoints.stylex.ts"

export const notFound = stylex.create({
  root: {
    paddingTop: { default: "7.5rem", [queries.phoneDown]: "4rem" },
    textAlign: "center",
  },
  title: { marginTop: "1rem" },
  lede: { marginInline: "auto" },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: "0.75rem",
    marginTop: "2.125rem",
  },
  art: { marginTop: { default: "4rem", [queries.phoneDown]: "2.5rem" } },
})
