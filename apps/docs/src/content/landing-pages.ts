import type { Metadata } from "next"

import { siteUrl } from "./build-origins.ts"
import { navigation } from "./navigation.ts"
import { markdownUrl, pageUrl } from "./page-markdown.ts"
import type { PageTitles } from "./sidebar.ts"
import { siteDescription } from "./site.ts"

/** One card on a generated page: its own title, and the published page it opens. */
export interface LandingCard {
  readonly title: string
  readonly slug: string
}

/** One group of cards on a generated page, laid out in `columns` columns. */
export interface LandingSection {
  readonly heading: string
  readonly columns: 2 | 3
  readonly cards: ReadonlyArray<LandingCard>
}

/** The pages the app writes itself instead of reading from `docs/`. */
export type LandingSlug = "welcome" | "api/overview"

/** A generated page: a title, one line under it, and groups of cards. */
export interface LandingPage {
  readonly slug: LandingSlug
  readonly title: string
  readonly description: string
  readonly sections: ReadonlyArray<LandingSection>
}

/** The welcome page. Each card's text is the description of the page it opens. */
export const welcomePage: LandingPage = {
  slug: "welcome",
  title: "Welcome to Akter",
  description: siteDescription,
  sections: [
    {
      heading: "Start here",
      columns: 2,
      cards: [
        { title: "Quickstart", slug: "quickstart" },
        { title: "Akter Cloud", slug: "cloud/get-started" },
      ],
    },
    {
      heading: "What you can do",
      columns: 3,
      cards: [
        { title: "Actors", slug: "guides/concepts" },
        { title: "Actions and jobs", slug: "guides/actions-and-jobs" },
        { title: "Testing", slug: "guides/testing" },
        { title: "Deploy", slug: "guides/deploy" },
        { title: "Self-host", slug: "operations/self-host" },
        { title: "API reference", slug: "api/01-server-api" },
      ],
    },
  ],
}

/** The API reference overview: one section per navigation group, titled by each page's own title. */
export const apiOverviewPage = (titles: PageTitles): LandingPage => ({
  slug: "api/overview",
  title: "API reference",
  description:
    "The actor contract, the Effect client, the CLI and the hosted Cloud API of Akter 0.2.",
  sections: navigation
    .filter((tab) => tab.product === "api-reference")
    .flatMap((tab) => tab.groups)
    .map((group) => ({
      heading: group.group,
      columns: 2,
      cards: group.pages.map((slug) => ({ title: titles(slug).title, slug })),
    })),
})

/** Every generated page, in the order the sitemap lists them. */
export const landingPages = (titles: PageTitles): ReadonlyArray<LandingPage> => [
  welcomePage,
  apiOverviewPage(titles),
]

/** A generated page as Markdown, with each card as a link to its page's Markdown twin. */
export const renderLandingMarkdown = (
  page: LandingPage,
  describe: (slug: string) => string | undefined,
): string =>
  [
    `# ${page.title}`,
    `> ${page.description}`,
    `Source: ${siteUrl}/${page.slug}`,
    ...page.sections.map((section) =>
      [
        `## ${section.heading}`,
        ...section.cards.map((card) => {
          const description = describe(card.slug)

          return `- [${card.title}](${markdownUrl(card.slug)})${description === undefined ? "" : `: ${description}`}`
        }),
      ].join("\n"),
    ),
  ]
    .join("\n\n")
    .concat("\n")

/** The title, description and addresses a generated page tells browsers and crawlers. */
export const landingMetadata = (page: LandingPage): Metadata => ({
  title: page.title,
  description: page.description,
  alternates: { canonical: pageUrl(page.slug) },
  openGraph: {
    url: pageUrl(page.slug),
    title: page.title,
    description: page.description,
  },
})
