/** One redirect, written in Cloudflare's `_redirects` terms: `*` is a splat, `:splat` its value. */
export interface Redirect {
  readonly source: string
  readonly destination: string
  readonly status: 301 | 302
}

const github = "https://github.com/Rika-Labs/akter/blob/main"

/**
 * Every address that used to answer on docs.akter.dev and now moves. A destination is a
 * published route or an external address; the repository's `docs/` files that are not
 * published go to GitHub.
 */
export const redirects: ReadonlyArray<Redirect> = [
  { source: "/", destination: "/welcome", status: 302 },
  { source: "/cloud/bring-your-database", destination: "/cloud/storage", status: 301 },
  {
    source: "/contracts/02-command-turns",
    destination: `${github}/docs/contracts/02-actions.md`,
    status: 301,
  },
  {
    source: "/contracts/03-transactions",
    destination: `${github}/docs/contracts/03-durability.md`,
    status: 301,
  },
  {
    source: "/contracts/04-receipts",
    destination: `${github}/docs/contracts/03-durability.md`,
    status: 301,
  },
  {
    source: "/contracts/06-storage-ownership",
    destination: `${github}/docs/contracts/06-storage.md`,
    status: 301,
  },
  { source: "/contracts/*", destination: `${github}/docs/contracts/:splat.md`, status: 301 },
  { source: "/decisions/*", destination: `${github}/docs/decisions/:splat.md`, status: 301 },
  { source: "/milestones/*", destination: `${github}/docs/milestones/:splat.md`, status: 301 },
  { source: "/BENCHMARKS", destination: `${github}/BENCHMARKS.md`, status: 301 },
  {
    source: "/product/competitive-positioning",
    destination: `${github}/docs/product/competitive-positioning.md`,
    status: 301,
  },
  { source: "/packages/*", destination: `${github}/packages/:splat`, status: 301 },
  { source: "/api/04-drizzle", destination: "/api/01-server-api", status: 301 },
  { source: "/api/05-generated-clients", destination: "/api/03-typescript-sdk", status: 301 },
  { source: "/api/post-foundation-sketches", destination: "/api/01-server-api", status: 301 },
  {
    source: "/architecture/data-model",
    destination: `${github}/docs/architecture/03-storage-layout.md`,
    status: 301,
  },
  {
    source: "/architecture/transaction-catalog",
    destination: `${github}/docs/architecture/04-dispatch.md`,
    status: 301,
  },
  { source: "/cloud/choose-postgres", destination: "/cloud/storage", status: 301 },
  { source: "/cloud/database", destination: "/cloud/storage", status: 301 },
  {
    source: "/operations/inspection-views",
    destination: "/operations/03-observability",
    status: 301,
  },
  {
    source: "/vision/03-relational-data",
    destination: `${github}/docs/vision/02-product-model.md`,
    status: 301,
  },
  {
    source: "/guides/effect-into-the-commit",
    destination: "/guides/actions-and-jobs",
    status: 301,
  },
]
