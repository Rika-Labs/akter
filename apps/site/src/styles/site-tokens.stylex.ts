import * as stylex from "@stylexjs/stylex"

/**
 * The marketing palette: a warm off-white page, a slightly darker tile, near-black ink, and one
 * hairline. Copy steps down from ink in fixed opacities so every grey on a page comes from here.
 */
export const siteColors = stylex.defineVars({
  page: "#fafaf9",
  tile: "#f1f0ed",
  selected: "#e9e8e4",
  bar: "#e4e3df",
  field: "#ffffff",
  ink: "#0b0d0b",
  hairline: "rgb(55 48 31 / 0.13)",
  muted: "rgb(11 13 11 / 0.55)",
  nav: "rgb(11 13 11 / 0.62)",
  soft: "rgb(11 13 11 / 0.7)",
  prose: "rgb(11 13 11 / 0.82)",
  dot: "rgb(11 13 11 / 0.16)",
  inverseSoft: "rgb(250 250 249 / 0.7)",
  ring: "rgb(11 13 11 / 0.6)",
})

/** Layout measures: the content column and the sticky header's height. */
export const siteDimensions = stylex.defineVars({
  column: "67.5rem",
  headerHeight: "4.25rem",
  gutter: "1.5rem",
})
