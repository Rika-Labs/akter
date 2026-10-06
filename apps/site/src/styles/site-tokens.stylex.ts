import * as stylex from "@stylexjs/stylex"

/**
 * The marketing palette: a warm off-white page, a slightly darker tile, near-black ink, one
 * hairline, and crane yellow as the single accent. Copy steps down from ink in fixed opacities so
 * every grey on a page comes from here. Illustrations take a faint wash of the accent so the one
 * solid yellow container stands out. The mark is yellow on the page, white on a yellow fill, and
 * ink on a page-coloured tile, so it always contrasts with what sits directly behind it.
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
  accent: "#ffc300",
  accentTop: "#ffd54d",
  accentEnd: "#cc9c00",
  accentInk: "#0b0d0b",
  sceneFace: "#fbf1d1",
  sceneTop: "#faf5e3",
  sceneEnd: "#fceaae",
  mark: "#ffc300",
  markOnAccent: "#ffffff",
})

/** Layout measures: the content column and the sticky header's height. */
export const siteDimensions = stylex.defineVars({
  column: "67.5rem",
  headerHeight: "4.25rem",
  gutter: "1.5rem",
})
