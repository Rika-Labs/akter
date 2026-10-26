import { readFileSync } from "node:fs"
import { join } from "node:path"

import { docsDirectory } from "../content/repository.ts"
import { siteName } from "../content/site.ts"

const mark = readFileSync(join(docsDirectory, "favicon.svg"), "utf8").replace(
  "<svg ",
  '<svg class="ak-mark" width="22" height="22" aria-hidden="true" ',
)

/**
 * The Akter tile and wordmark. The tile is the repository's favicon inlined, so the corner logo
 * matches the browser tab and the website and console; the word is live text in the site font, so
 * it reads "Akter", follows the page colour, and needs no second artwork for dark mode.
 */
export function Logo() {
  return (
    <>
      <span className="ak-mark-frame" dangerouslySetInnerHTML={{ __html: mark }} />
      <span className="ak-wordmark-text">{siteName}</span>
    </>
  )
}
