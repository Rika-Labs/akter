import { space } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"

export const notFound = stylex.create({
  root: {
    display: "grid",
    justifyItems: "center",
    gap: space.xl,
    paddingBlock: space.huge,
    textAlign: "center",
  },
  svg: { width: "100%", maxWidth: "26rem", height: "auto", overflow: "visible", opacity: 0.94 },
  actions: { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: space.md },
})
