import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import { publishedSlugs } from "../src/content/navigation.ts"
import { redirects } from "../src/content/redirects.ts"
import { defaultSiteUrl, siteUrl } from "../src/content/build-origins.ts"
import { renderHeaders, renderRedirects } from "../src/hosting/cloudflare.ts"

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

await writeFile(
  join(out, "_headers"),
  renderHeaders({
    pagePaths: ["/", "/welcome", ...publishedSlugs.map((slug) => `/${slug}`)],
  }),
)

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

const stylesheets = await Promise.all(
  (await files(out)).filter((file) => file.endsWith(".css")).map((file) => readFile(file, "utf8")),
)

for (const family of ["Inter", "Geist Mono"])
  if (
    !stylesheets.some((css) =>
      css.includes(`font-family:${family};src:url(data:font/woff2;base64,`),
    )
  )
    throw new Error(`No stylesheet in the export carries ${family}`)

if (leaks.length > 0)
  throw new Error(
    `The export holds text it must not: the production site address when SITE_URL is set, or the retired PolySans face:\n${leaks.join("\n")}`,
  )
