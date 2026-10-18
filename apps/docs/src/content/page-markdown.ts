import { siteDescription, siteName, siteUrl } from "./site.ts"

/** One published page, ready to be written out as Markdown. */
export interface MarkdownPage {
  readonly slug: string
  readonly title: string
  readonly description?: string | undefined
  readonly body: string
}

/** The address of a page on the site. */
export const pageUrl = (slug: string): string => `${siteUrl}/${slug}`

/** The address of a page's Markdown twin. */
export const markdownUrl = (slug: string): string => `${siteUrl}/${slug}.md`

/** A page as Markdown: its title and description, a link back to the HTML page, then the body. */
export const renderPageMarkdown = (page: MarkdownPage): string =>
  [
    `# ${page.title}`,
    page.description === undefined ? undefined : `> ${page.description}`,
    `Source: ${pageUrl(page.slug)}`,
    page.body.trim(),
  ]
    .filter((part) => part !== undefined)
    .join("\n\n")
    .concat("\n")

/** One group of the `llms.txt` index. */
export interface LlmsSection {
  readonly heading: string
  readonly pages: ReadonlyArray<{
    readonly slug: string
    readonly title: string
    readonly description?: string | undefined
  }>
}

/** The `llms.txt` index: the site, then every tab's pages as links to their Markdown twins. */
export const renderLlmsIndex = (sections: ReadonlyArray<LlmsSection>): string =>
  [
    `# ${siteName}`,
    `> ${siteDescription}`,
    ...sections.map((section) =>
      [
        `## ${section.heading}`,
        ...section.pages.map(
          (page) =>
            `- [${page.title}](${markdownUrl(page.slug)})${page.description === undefined ? "" : `: ${page.description}`}`,
        ),
      ].join("\n"),
    ),
  ]
    .join("\n\n")
    .concat("\n")
