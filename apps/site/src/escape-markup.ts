/** Escapes the characters that would end a text node or an attribute value in generated markup. */
export const escapeMarkup = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
