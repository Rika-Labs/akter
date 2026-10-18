import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { fontFace } from "../src/content/font-stylesheet.ts"

const fonts = resolve(import.meta.dirname, "..", "..", "..", "docs", "fonts")
const cache = resolve(import.meta.dirname, "..", ".cache")

await mkdir(cache, { recursive: true })
await writeFile(
  join(cache, "fonts.css"),
  fontFace({
    family: "Geist Sans",
    bytes: await readFile(join(fonts, "GeistSans-latin.woff2")),
    weight: "100 900",
  }) +
    fontFace({
      family: "Geist Mono",
      bytes: await readFile(join(fonts, "GeistMono-latin.woff2")),
      weight: "100 900",
    }),
)
