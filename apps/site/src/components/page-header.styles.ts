import { space } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"

export const pageHeader = stylex.create({
  root: {
    paddingBlock: {
      default: `${space.huge} ${space.xxxl}`,
      [queries.phoneDown]: `${space.xxxl} ${space.xl}`,
    },
  },
  center: { textAlign: "center", justifyItems: "center", display: "grid" },
  extra: { marginTop: space.xl },
})
