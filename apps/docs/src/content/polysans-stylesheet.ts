const WOFF2_SIGNATURE = [0x77, 0x4f, 0x46, 0x32]

/** True when the bytes start with the WOFF2 signature, which is all a font fetch must prove. */
export const isWoff2 = (bytes: Uint8Array): boolean =>
  WOFF2_SIGNATURE.every((byte, index) => bytes[index] === byte)

/**
 * The `@font-face` rule that carries PolySans inside the stylesheet. The font is part of the
 * render-blocking CSS because a font file requested after the first paint reaches WebKit too
 * late: it paints the fallback face, then reflows when the real face arrives. The same bytes
 * always give the same text, so the export stays reproducible for a given font file.
 */
export const polySansStylesheet = (bytes: Uint8Array): string =>
  `@font-face{font-family:"PolySans Var";src:url(data:font/woff2;base64,${Buffer.from(bytes).toString("base64")}) format("woff2");font-weight:300 800;font-display:optional}\n`
