import { space, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"

export const heading = stylex.create({
  root: { display: "grid", gap: space.md, justifyItems: "start" },
  center: { justifyItems: "center", textAlign: "center" },
  title: {
    fontSize: {
      default: typography.displayMd,
      [queries.phoneDown]: typography.displaySm,
    },
    textWrap: "balance",
  },
  page: {
    fontSize: {
      default: "clamp(2.75rem, 7vw, 4.5rem)",
      [queries.phoneDown]: "2.5rem",
    },
    lineHeight: 1,
    letterSpacing: "-0.03em",
  },
  small: { fontSize: { default: typography.title, [queries.phoneDown]: "1.5rem" } },
  lead: {
    maxWidth: "40rem",
    fontSize: { default: "1.0625rem", [queries.phoneDown]: typography.lead },
    lineHeight: 1.55,
    textWrap: "pretty",
  },
})
