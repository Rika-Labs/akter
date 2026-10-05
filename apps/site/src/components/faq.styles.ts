import { typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"
import { questionMarker } from "../styles/markers.stylex.ts"
import { siteColors } from "../styles/site-tokens.stylex.ts"

export const faq = stylex.create({
  list: { display: "grid" },
  item: {
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: siteColors.hairline,
    ":first-child": {
      borderTopWidth: 1,
      borderTopStyle: "solid",
      borderTopColor: siteColors.hairline,
    },
  },
  summary: {
    display: "grid",
    gridTemplateColumns: {
      default: "2.5rem minmax(0, 1fr) 1rem",
      [queries.phoneDown]: "2rem minmax(0, 1fr) 1rem",
    },
    alignItems: "baseline",
    paddingBlock: "1rem",
    cursor: "pointer",
    fontSize: { default: "1rem", [queries.phoneDown]: "0.9375rem" },
    outlineWidth: { default: 0, ":focus-visible": 2 },
    outlineStyle: "solid",
    outlineColor: siteColors.ring,
    outlineOffset: -2,
  },
  number: {
    fontFamily: typography.mono,
    fontSize: "0.75rem",
    color: siteColors.muted,
  },
  question: { textWrap: "pretty" },
  icon: { justifySelf: "end", alignSelf: "center", color: siteColors.muted },
  stem: {
    opacity: { default: 1, [stylex.when.ancestor("[open]", questionMarker)]: 0 },
  },
  answer: {
    paddingBottom: "1.25rem",
    paddingInlineStart: { default: "2.5rem", [queries.phoneDown]: "2rem" },
    paddingInlineEnd: "1rem",
    maxWidth: "44rem",
    fontSize: "0.96875rem",
    lineHeight: 1.65,
    color: siteColors.soft,
  },
})
