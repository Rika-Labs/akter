import geistMono from "@akter/ui/fonts/GeistMono-latin.woff2?url"
import polySans from "@akter/ui/fonts/PolySans-variable.woff2?url"

/** The font file the layout preloads: the face every page paints above the fold. */
export const preloadedFonts: ReadonlyArray<string> = [polySans]

/**
 * The `@font-face` rules for the two brand fonts, served from `@akter/ui`'s assets. They are
 * emitted inline because the files only exist as hashed asset URLs at build time.
 */
export const fontFaces = `
@font-face { font-family: "PolySans Var"; src: url("${polySans}") format("woff2"); font-weight: 300 800; font-display: swap; }
@font-face { font-family: "Geist Mono"; src: url("${geistMono}") format("woff2"); font-weight: 100 900; font-display: swap; }
`
