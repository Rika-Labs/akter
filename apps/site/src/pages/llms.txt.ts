import type { APIRoute } from "astro"
import { loadDocs } from "../docs/collection.ts"
import { benchmarkReportUrl, githubUrl, headline, siteUrl } from "../site.ts"

export const GET: APIRoute = async () => {
  const docs = await loadDocs()
  const sections = docs.sidebar.map((group) =>
    [
      `## ${group.title}`,
      "",
      ...group.pages.map(
        (page) => `- [${page.label}](${siteUrl}${page.markdownUrl}): ${page.description}`,
      ),
    ].join("\n"),
  )
  const body = [
    "# Akter",
    "",
    `> ${headline}`,
    "",
    "Akter is an actor framework for TypeScript. Each actor is an addressable part of an app, such as one order, one room or one agent session. It handles one command at a time inside one database transaction, and keeps its state, rows, events and pending work in your Postgres. It is alpha, runs on Bun and Effect, and is Apache-2.0 licensed.",
    "",
    "Every page below is available as raw Markdown at its URL. The full documentation as one file is at " +
      `${siteUrl}/llms-full.txt.`,
    "",
    ...sections.flatMap((section) => [section, ""]),
    "## Optional",
    "",
    `- [Benchmarks](${benchmarkReportUrl}): the consolidated performance and recovery report, with method and caveats.`,
    `- [Source](${githubUrl}): the repository, issues and licence.`,
    "",
  ].join("\n")

  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } })
}
