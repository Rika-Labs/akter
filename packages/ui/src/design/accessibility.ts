import * as stylex from "@stylexjs/stylex"
import { borders, colors, space } from "../tokens.stylex.ts"

/** Shared accessibility fragments: text for assistive technology only, and the keyboard focus ring. */
export const accessibility = stylex.create({
  visuallyHidden: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: 0,
    margin: "-1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    borderWidth: 0,
  },
  focusRing: {
    outlineStyle: "solid",
    outlineColor: colors.ring,
    outlineOffset: space.xxs,
    outlineWidth: { default: 0, ":focus-visible": borders.focus },
  },
  focusInset: {
    outlineStyle: "solid",
    outlineColor: colors.ring,
    outlineOffset: `calc(-1 * ${borders.focus})`,
    outlineWidth: { default: 0, ":focus-visible": borders.focus },
  },
})
