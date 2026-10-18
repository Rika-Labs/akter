/**
 * Inline script that lifts the font gate. The gate is the `data-font-gate` attribute on the
 * `html` element, which a style turns into a hidden page; the script removes the attribute
 * once PolySans is ready, or when loading it fails or takes longer than the backstop, so a
 * missing font never leaves a blank page. WebKit paints before a font that is in the stylesheet
 * has been decoded, and the swap then reflows the text; holding the page back until the face
 * is usable means no engine paints text in a face it will replace. The gate is an attribute,
 * not an element, because React rebuilds the whole page when a server-rendered element has
 * been removed before it hydrates, and the rebuilt page would carry the gate again.
 */
export const fontGateScript = [
  "(function(){var d=document;",
  "var open=function(){d.documentElement.removeAttribute('data-font-gate')};",
  "try{d.fonts.load('1em \"PolySans Var\"').then(open,open)}catch(e){open()}",
  "setTimeout(open,1500)})()",
].join("")

/** The style that hides the page while the `html` element carries `data-font-gate`. */
export const fontGateStyle = "html[data-font-gate]{visibility:hidden}"

/** The style, inside `noscript`, that shows the page when there is no script to lift the gate. */
export const fontGateNoScriptStyle = "html[data-font-gate]{visibility:visible}"
