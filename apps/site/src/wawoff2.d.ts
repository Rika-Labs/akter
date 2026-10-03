declare module "wawoff2" {
  /** Converts a WOFF2 font to TrueType, the one conversion the Open Graph renderer needs. */
  export function decompress(woff2: Uint8Array): Promise<Uint8Array>

  const converter: { readonly decompress: typeof decompress }

  export default converter
}
