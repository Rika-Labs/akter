/** One sidebar group: its heading and the repository documents it lists, in order. */
export interface Group {
  readonly title: string
  readonly entries: ReadonlyArray<{ readonly id: string; readonly label: string }>
}

/**
 * The documentation's sidebar. Each entry names a document under the repository's `docs/`
 * directory and the short label the sidebar shows. A document the globs pick up that is not
 * listed here is appended to the group named by its folder, so a new page is never lost.
 */
export const groups: ReadonlyArray<Group> = [
  {
    title: "Get started",
    entries: [
      { id: "quickstart.md", label: "Quickstart" },
      { id: "guides/concepts.md", label: "Concepts" },
      { id: "product/fit-and-non-fit.md", label: "Fit and non-fit" },
    ],
  },
  {
    title: "Guides",
    entries: [
      { id: "guides/effect-into-the-commit.md", label: "Effect into the commit" },
      { id: "guides/testing.md", label: "Testing" },
      { id: "guides/deploy.md", label: "Deploy" },
    ],
  },
  {
    title: "Reference",
    entries: [
      { id: "api/README.md", label: "API overview" },
      { id: "api/01-server-api.md", label: "Server API" },
      { id: "api/02-context.md", label: "Context services" },
      { id: "api/03-typescript-sdk.md", label: "TypeScript SDK" },
      { id: "api/04-drizzle.md", label: "Drizzle" },
      { id: "api/05-generated-clients.md", label: "Generated clients" },
      { id: "api/06-cli.md", label: "CLI" },
      { id: "api/generated-contracts.md", label: "Generated contracts" },
      { id: "api/naming.md", label: "Naming" },
      { id: "api/versioning.md", label: "Versioning" },
      { id: "api/post-foundation-sketches.md", label: "Post-foundation sketches" },
    ],
  },
  {
    title: "Compare",
    entries: [{ id: "guides/comparison.md", label: "Durable Objects, Rivet, Restate, Temporal" }],
  },
]

/** The group a document joins when the sidebar does not list it, by its folder. */
export const fallbackGroup = (id: string): string =>
  id.startsWith("api/") ? "Reference" : "Guides"
