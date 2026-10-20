import localFont from "next/font/local"

/**
 * Inter for text and Geist Mono for code, both latin subsets under the SIL Open Font Licence,
 * committed in `docs/fonts/`. Next copies each file into the export under a name that carries
 * a hash of its bytes, writes the `@font-face` rule into the render-blocking stylesheet and
 * puts a preload link for the file in every page's head, so the request starts before the body
 * is parsed and the face is ready for the first layout. The faces are named `Inter` and
 * `Geist Mono`, as the reference names its own, and the stylesheet's font stacks name them
 * directly; the root element carries the variable classes because that is how Next learns the
 * faces are in use and which files to preload. The faces are `optional`: a face that is late
 * is not swapped in, so no line of text changes width after the first paint. The fallback faces
 * the stylesheet declares are sized to the metrics of these two.
 */
export const inter = localFont({
  src: "../../../../docs/fonts/Inter-latin.woff2",
  weight: "100 900",
  display: "optional",
  variable: "--font-inter",
  adjustFontFallback: false,
  declarations: [{ prop: "font-family", value: "Inter" }],
})

export const geistMono = localFont({
  src: "../../../../docs/fonts/GeistMono-latin.woff2",
  weight: "100 900",
  display: "optional",
  variable: "--font-geist-mono",
  adjustFontFallback: false,
  declarations: [{ prop: "font-family", value: "Geist Mono" }],
})
