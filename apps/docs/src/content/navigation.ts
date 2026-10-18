/** One sidebar group: its heading and the page slugs under it, in reading order. */
export interface NavigationGroup {
  readonly group: string
  readonly pages: ReadonlyArray<string>
}

/** One top-level tab and the groups it lists. */
export interface NavigationTab {
  readonly tab: string
  readonly groups: ReadonlyArray<NavigationGroup>
}

/**
 * The only list of published pages. A slug is the path of a Markdown file under the
 * repository's `docs/` directory without its extension, and is also the page's URL.
 */
export const navigation: ReadonlyArray<NavigationTab> = [
  {
    tab: "Guides",
    groups: [
      {
        group: "Get started",
        pages: [
          "quickstart",
          "guides/concepts",
          "guides/actions-and-jobs",
          "product/fit-and-non-fit",
        ],
      },
      {
        group: "Guides",
        pages: ["guides/testing", "guides/deploy", "guides/comparison"],
      },
      {
        group: "Self-host operations",
        pages: [
          "operations/self-host",
          "operations/01-deployment",
          "operations/02-migrations",
          "operations/03-observability",
          "operations/04-backup-restore",
          "operations/support-matrix",
          "operations/runbooks",
          "operations/retention",
          "operations/alpha-upgrades",
          "operations/05-releasing",
        ],
      },
    ],
  },
  {
    tab: "Akter Cloud",
    groups: [
      {
        group: "Akter Cloud",
        pages: [
          "cloud/get-started",
          "cloud/storage",
          "cloud/deploy",
          "cloud/environment-variables",
          "cloud/logs",
          "cloud/pricing-and-limits",
          "cloud/account-and-data",
        ],
      },
    ],
  },
  {
    tab: "API reference",
    groups: [
      {
        group: "Runtime",
        pages: [
          "api/01-server-api",
          "api/02-context",
          "api/03-typescript-sdk",
          "api/jobs",
          "api/lists-and-find",
          "api/forks",
        ],
      },
      {
        group: "Clients and CLI",
        pages: [
          "api/06-cli",
          "api/07-cloud-logs",
          "api/08-cloud-usage",
          "api/09-environment-api-keys",
          "api/generated-contracts",
        ],
      },
      {
        group: "Conventions",
        pages: ["api/naming", "api/versioning"],
      },
    ],
  },
]

/** Every published slug in navigation order. */
export const publishedSlugs: ReadonlyArray<string> = navigation.flatMap((tab) =>
  tab.groups.flatMap((group) => group.pages),
)
