import * as stylex from "@stylexjs/stylex"

/**
 * Colour roles the website needs beyond `@akter/ui`'s tokens: body copy a step stronger than the
 * muted role, and the inverse roles for the one ink-filled surface on each page.
 */
export const siteColors = stylex.defineVars({
  bodyForeground: "light-dark(rgb(11 13 11 / 0.8), rgb(236 235 231 / 0.8))",
  inverseSoft: "light-dark(rgb(250 250 249 / 0.8), rgb(18 19 17 / 0.8))",
  inverseMuted: "light-dark(rgb(250 250 249 / 0.6), rgb(18 19 17 / 0.6))",
  inverseHairline: "light-dark(rgb(250 250 249 / 0.16), rgb(18 19 17 / 0.16))",
  figureStroke: "light-dark(rgb(11 13 11 / 0.82), rgb(236 235 231 / 0.78))",
})

/** Layout measures the website uses on top of `@akter/ui`'s dimensions. */
export const siteDimensions = stylex.defineVars({
  landingColumn: "67.5rem",
  headerHeight: "4rem",
  docsNav: "14.5rem",
  docsOutline: "12.5rem",
})
