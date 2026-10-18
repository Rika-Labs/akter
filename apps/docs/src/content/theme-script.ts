/** The local-storage key that holds the reader's choice of Light or Dark. */
export const themeStorageKey = "akter-theme"

/**
 * Inline script for the document head. A reader who chose Light or Dark gets that class on
 * the root element before the first paint, so the page never shows the other theme first.
 * Without a stored choice it does nothing and the stylesheet follows the operating system.
 */
export const themeScript = [
  "(function(){try{",
  `var t=window.localStorage.getItem('${themeStorageKey}');`,
  "if(t==='light'||t==='dark')document.documentElement.classList.add(t)",
  "}catch(e){}})()",
].join("")
