import { repositoryFileUrl } from "./links.ts"
import { pageBase, repositoryLinks, sections } from "./pages.ts"
import type { SitePage } from "./render.ts"

/**
 * The site index in the `llms.txt` format (https://llmstxt.org): a title, a
 * one-line summary, then one list per section linking each page's Markdown
 * copy. Links are relative to the site root, where the file is served.
 */
export const renderLlmsText = (site: ReadonlyArray<SitePage>) => {
  const lines = [
    "# Durable Actors",
    "",
    "> An Effect-native actor framework on Postgres. Each command runs as one turn: the actor's state, its owned Drizzle rows, events, receipts and outgoing work commit in one database transaction.",
    "",
    "Each link below is the Markdown copy of a page on this site. Runtime contracts and architecture decisions are not published here; they stay in the repository and are listed under Optional.",
  ]

  for (const section of sections) {
    lines.push("", `## ${section}`, "")

    for (const page of site.filter((entry) => entry.section === section))
      lines.push(`- [${page.title}](${pageBase(page.source)}.md): ${page.summary}`)
  }

  lines.push("", "## Optional", "")

  for (const link of repositoryLinks)
    lines.push(`- [${link.title}](${repositoryFileUrl(link.path)})`)

  return `${lines.join("\n")}\n`
}
