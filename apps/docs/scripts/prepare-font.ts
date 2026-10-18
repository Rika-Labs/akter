import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { polySansStylesheet } from "../src/content/polysans-stylesheet.ts"
import { loadFont } from "../src/hosting/polysans-source.ts"

const cache = resolve(import.meta.dirname, "..", ".cache")

await mkdir(cache, { recursive: true })
await writeFile(join(cache, "polysans.css"), polySansStylesheet(await loadFont()))
