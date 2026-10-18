import { readFile } from "node:fs/promises"

import { polySansUrl } from "../content/build-origins.ts"
import { isWoff2 } from "../content/polysans-stylesheet.ts"

const ATTEMPTS = 3

const fetchFont = async (): Promise<Uint8Array> => {
  let failure = ""

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1)
    try {
      const response = await fetch(polySansUrl, { signal: AbortSignal.timeout(20_000) })

      if (!response.ok) failure = `${response.status} ${response.statusText}`
      else {
        const bytes = new Uint8Array(await response.arrayBuffer())

        if (isWoff2(bytes)) return bytes
        failure = "the response is not a WOFF2 file"
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

  throw new Error(
    `PolySans could not be fetched from ${polySansUrl} (${failure}). Set FONT_ORIGIN to the origin that serves it, or POLYSANS_FILE to a local copy.`,
  )
}

/**
 * The PolySans bytes the stylesheet embeds: the file named by `POLYSANS_FILE` when it is set,
 * else the file the font origin serves. The font is licensed and never committed, so the build
 * must reach one of the two; it fails, naming both, rather than ship a site without its face.
 * Two builds that read one file give one export, which is what the reproducibility check pins.
 */
export const loadFont = async (): Promise<Uint8Array> => {
  const local = process.env["POLYSANS_FILE"]
  const bytes = local === undefined ? await fetchFont() : new Uint8Array(await readFile(local))

  if (!isWoff2(bytes)) throw new Error("The PolySans file is not a WOFF2 file")

  return bytes
}
