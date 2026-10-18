/**
 * One `@font-face` rule that carries a font inside the stylesheet as a `data:` URL. A font
 * that lives in the render-blocking stylesheet is there when the first paint happens, so no
 * engine paints a fallback face first and swaps it later: a font file requested after the
 * page starts reaches WebKit too late, and it then reflows the text up to 300 px. The same
 * bytes give the same text, so the export stays reproducible.
 */
export const fontFace = (input: {
  readonly family: string
  readonly bytes: Uint8Array
  readonly weight: string
}): string =>
  `@font-face{font-family:"${input.family}";src:url(data:font/woff2;base64,${Buffer.from(input.bytes).toString("base64")}) format("woff2");font-weight:${input.weight};font-display:optional}\n`
