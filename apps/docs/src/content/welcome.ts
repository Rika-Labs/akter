import { markdownUrl, pageUrl } from "./page-markdown.ts"
import { siteDescription, siteUrl } from "./site.ts"

/** One card on the welcome page: its own title, and the published page it opens. */
export interface WelcomeCard {
  readonly title: string
  readonly slug: string
}

/** One group of cards on the welcome page. */
export interface WelcomeSection {
  readonly heading: string
  readonly cards: ReadonlyArray<WelcomeCard>
}

export const welcomeTitle = "Welcome to Akter"

export const welcomeDescription = siteDescription

/** The welcome page's cards. Each card's text is the description of the page it opens. */
export const welcomeSections: ReadonlyArray<WelcomeSection> = [
  {
    heading: "Start here",
    cards: [
      { title: "Quickstart", slug: "quickstart" },
      { title: "Akter Cloud", slug: "cloud/get-started" },
    ],
  },
  {
    heading: "What you can do",
    cards: [
      { title: "Actors", slug: "guides/concepts" },
      { title: "Actions and jobs", slug: "guides/actions-and-jobs" },
      { title: "Testing", slug: "guides/testing" },
      { title: "Deploy", slug: "guides/deploy" },
      { title: "Self-host", slug: "operations/self-host" },
      { title: "API reference", slug: "api/01-server-api" },
    ],
  },
]

/** The welcome page as Markdown, with each card as a link to its page's Markdown twin. */
export const renderWelcomeMarkdown = (describe: (slug: string) => string | undefined): string =>
  [
    `# ${welcomeTitle}`,
    `> ${welcomeDescription}`,
    `Source: ${siteUrl}/welcome`,
    ...welcomeSections.map((section) =>
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

export const welcomePageUrl = pageUrl("welcome")
