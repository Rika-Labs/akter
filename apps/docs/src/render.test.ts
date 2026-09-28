import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"

import {
  PageHeaderMissing,
  readHeader,
  renderHtmlPage,
  renderMarkdownCopy,
  type SitePage,
} from "./render.ts"

const header = (title: string) =>
  `# ${title}\n\n**Responsibility:** explain the \`turn\` [context](02-context.md).  \n**Authority:** design.\n`

const page = (source: string, title: string, body: string) =>
  Effect.gen(function* () {
    const markdown = `${header(title)}\n${body}`

    const read = yield* readHeader({ source, markdown })

    return { source, section: "API reference", markdown, ...read } satisfies SitePage
  })

const serverBody = [
  "See [the turn](02-context.md#the-turn), [contract 02](../contracts/02-command-turns.md),",
  'and [a titled link](02-context.md "Context") and [a reference][ref]. Code keeps its text:',
  "",
  "```md",
  "[not a link](02-context.md) and [contract 02](../contracts/02-command-turns.md),",
  "```",
  "",
  "[ref]: ../quickstart.md",
  "",
].join("\n")

const fixture = Effect.gen(function* () {
  const context = yield* page(
    "api/02-context.md",
    "Context <capabilities>",
    "## The turn\n\nText.\n",
  )

  const server = yield* page("api/01-server-api.md", "Server API", serverBody)

  const site = [server, context]

  return { context, server, site, published: new Set(site.map((entry) => entry.source)) }
})

const blob = "https://github.com/Rika-Labs/durable-actors/blob/main"

describe("readHeader", () => {
  it.effect("reads the title and the responsibility line as plain text", () =>
    Effect.gen(function* () {
      const { context } = yield* fixture

      expect({ title: context.title, summary: context.summary }).toEqual({
        title: "Context <capabilities>",
        summary: "explain the turn context.",
      })
    }),
  )

  it.effect("keeps literal punctuation that is not Markdown syntax", () =>
    Effect.gen(function* () {
      const read = yield* readHeader({
        source: "api/x.md",
        markdown:
          "# The actor_id column\n\n**Responsibility:** scope rows by actor_id and 2*3 **tables**.\n",
      })

      expect(read).toEqual({
        title: "The actor_id column",
        summary: "scope rows by actor_id and 2*3 tables.",
      })
    }),
  )

  it.effect(
    "rejects a page whose title or responsibility line is missing or not in its header",
    () =>
      Effect.gen(function* () {
        const untitled = yield* Effect.flip(
          readHeader({ source: "api/x.md", markdown: "**Responsibility:** y\n" }),
        )

        const unowned = yield* Effect.flip(readHeader({ source: "api/x.md", markdown: "# T\n" }))

        const lateTitle = yield* Effect.flip(
          readHeader({
            source: "api/x.md",
            markdown: "Intro\n\n```md\n# Example\n\n**Responsibility:** y\n```\n",
          }),
        )

        const lateResponsibility = yield* Effect.flip(
          readHeader({ source: "api/x.md", markdown: "# T\n\nIntro.\n\n**Responsibility:** y\n" }),
        )

        expect(untitled).toEqual(PageHeaderMissing.make({ source: "api/x.md", field: "title" }))
        expect(lateTitle).toEqual(PageHeaderMissing.make({ source: "api/x.md", field: "title" }))
        expect(lateResponsibility).toEqual(
          PageHeaderMissing.make({ source: "api/x.md", field: "responsibility" }),
        )
        expect(unowned).toEqual(
          PageHeaderMissing.make({ source: "api/x.md", field: "responsibility" }),
        )
      }),
  )
})

describe("renderMarkdownCopy", () => {
  it.effect("rewrites links to published pages as Markdown siblings and the rest to GitHub", () =>
    Effect.gen(function* () {
      const { server, published } = yield* fixture

      const copy = yield* renderMarkdownCopy({ page: server, published })

      expect(copy).toContain("[the turn](02-context.md#the-turn)")
      expect(copy).toContain(`[contract 02](${blob}/docs/contracts/02-command-turns.md)`)
      expect(copy).toContain('[a titled link](02-context.md "Context")')
      expect(copy).toContain(`[ref]: ${blob}/docs/quickstart.md`)
      expect(copy).toContain(
        "```md\n[not a link](02-context.md) and [contract 02](../contracts/02-command-turns.md),\n```",
      )
    }),
  )
})

describe("renderHtmlPage", () => {
  it.effect("links published pages as HTML and keeps heading anchors", () =>
    Effect.gen(function* () {
      const { server, context, site } = yield* fixture

      expect(yield* renderHtmlPage({ page: server, site })).toContain(
        'href="02-context.html#the-turn"',
      )
      expect(yield* renderHtmlPage({ page: context, site })).toContain(
        '<h2 id="the-turn">The turn</h2>',
      )
    }),
  )

  it.effect("marks the current page in the sidebar and escapes page titles", () =>
    Effect.gen(function* () {
      const { server, site } = yield* fixture

      const html = yield* renderHtmlPage({ page: server, site })

      expect(html).toContain(
        '<a href="../api/01-server-api.html" aria-current="page">Server API</a>',
      )
      expect(html).toContain("Context &lt;capabilities&gt;")
      expect(html).not.toContain("Context <capabilities>")
    }),
  )

  it.effect("offers the page's Markdown copy and its GitHub source", () =>
    Effect.gen(function* () {
      const { server, site } = yield* fixture

      const html = yield* renderHtmlPage({ page: server, site })

      expect(html).toContain('<link rel="alternate" type="text/markdown" href="01-server-api.md">')
      expect(html).toContain('<a href="01-server-api.md">View as Markdown</a>')
      expect(html).toContain(`href="${blob}/docs/api/01-server-api.md">Source on GitHub`)
    }),
  )
})
