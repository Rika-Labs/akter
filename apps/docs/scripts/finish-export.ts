import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import { publishedSlugs } from "../src/content/navigation.ts"
import { redirects } from "../src/content/redirects.ts"
import { defaultSiteUrl, siteUrl } from "../src/content/build-origins.ts"
import { renderHeaders, renderRedirects } from "../src/hosting/cloudflare.ts"
import {
  dataUrls,
  fontPreloadProblems,
  fontPreloadTags,
  fontPreloads,
  withFontPreloads,
} from "../src/hosting/font-delivery.ts"

const out = resolve(import.meta.dirname, "..", "out")

const files = async (directory: string): Promise<ReadonlyArray<string>> =>
  (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map(async (entry) =>
        entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
      ),
    )
  ).flat()

for (const file of await files(join(out, "md"))) {
  const target = join(out, `${relative(join(out, "md"), file)}.md`)

  await mkdir(dirname(target), { recursive: true })
  await rename(file, target)
}

await rm(join(out, "md"), { recursive: true })

await writeFile(join(out, "_redirects"), renderRedirects(redirects))

await writeFile(join(out, "_headers"), renderHeaders())

const missing = ["welcome", ...publishedSlugs].flatMap((slug) =>
  [`${slug}.html`, `${slug}.md`].filter((file) => !existsSync(join(out, file))),
)

for (const file of [
  "index.html",
  "404.html",
  "llms.txt",
  "llms-full.txt",
  "search.json",
  "search-sections.json",
  "sitemap.xml",
  "robots.txt",
  "favicon.svg",
  "_redirects",
  "_headers",
])
  if (!existsSync(join(out, file))) missing.push(file)

if (missing.length > 0) throw new Error(`The export is missing: ${missing.join(", ")}`)

const forbidden = [...(siteUrl === defaultSiteUrl ? [] : [defaultSiteUrl]), "PolySans"]

const leaks: Array<string> = []

for (const file of await files(out))
  if (/\.(html|txt|xml|md|js|css|json)$/.test(file) || file.endsWith("_headers")) {
    const text = await readFile(file, "utf8")

    for (const needle of forbidden)
      if (text.includes(needle)) leaks.push(`${relative(out, file)} contains ${needle}`)
  }

/**
 * The pages Next renders for an unknown address come out with no font preload, although its font
 * manifest lists both faces for them, so a reader who lands on one first would see the fallback
 * face. They get the links the welcome page has, which name the same two files.
 */
const preloadNotFoundFonts = async () => {
  const links = fontPreloadTags(await readFile(join(out, "welcome.html"), "utf8"))

  for (const name of ["404.html", "_not-found.html"]) {
    const file = join(out, name)
    const html = await readFile(file, "utf8")

    if (fontPreloadTags(html).length === 0) await writeFile(file, withFontPreloads(html, links))
  }
}

await preloadNotFoundFonts()

const faces = 2

const delivery: Array<string> = []

for (const file of (await files(out)).filter((candidate) => /\.(html|css)$/.test(candidate))) {
  const text = await readFile(file, "utf8")
  const name = relative(out, file)

  for (const url of dataUrls(text)) delivery.push(`${name} carries a data URL (${url})`)

  if (!file.endsWith(".html")) continue

  for (const problem of fontPreloadProblems(text, faces)) delivery.push(`${name} ${problem}`)

  for (const { href } of fontPreloads(text))
    if (!existsSync(join(out, href)))
      delivery.push(`${name} preloads ${href}, which is not in the export`)
}

if (delivery.length > 0)
  throw new Error(
    `The fonts are not delivered as hashed files with a preload, or a data URL is back:\n${delivery.slice(0, 40).join("\n")}`,
  )

if (leaks.length > 0)
  throw new Error(
    `The export holds text it must not: the production site address when SITE_URL is set, or the retired PolySans face:\n${leaks.join("\n")}`,
  )
