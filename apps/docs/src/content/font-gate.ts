/**
 * Inline script for the document head that closes the font gate: it puts the `data-font-gate`
 * attribute on the `html` element, and a style turns that attribute into a hidden page. The
 * attribute is set here and never rendered by React. When something changes the page before it
 * hydrates (a translation tool, an extension), React throws the server markup away and renders
 * the page again, and a gate that was part of what it renders comes back after the script has
 * lifted it, leaving the page hidden for good. A page without scripts never gets the gate.
 */
export const fontGateStartScript = "document.documentElement.setAttribute('data-font-gate','')"

/**
 * Inline script for the end of the body that opens the font gate once Inter and Geist Mono
 * are decoded, or when loading either fails or takes longer than the backstop, so a missing
 * font never leaves a blank page. Both faces are embedded in the stylesheet, but an engine
 * decodes a face only after it has laid out the first text, and a page that paints in that gap
 * draws boxes laid out for the fallback and then moves them when the face arrives: WebKit does
 * it on most loads and Chromium on some when no page script is competing for the main thread.
 * Holding the page back until both faces are usable means nothing paints that a font will move.
 */
export const fontGateScript = [
  "(function(){var d=document;",
  "var open=function(){d.documentElement.removeAttribute('data-font-gate')};",
  "try{Promise.all([d.fonts.load('1em Inter'),d.fonts.load('1em \"Geist Mono\"')]).then(open,open)}catch(e){open()}",
  "setTimeout(open,1500)})()",
].join("")

/** The style that hides the page while the `html` element carries `data-font-gate`. */
export const fontGateStyle = "html[data-font-gate]{visibility:hidden}"
