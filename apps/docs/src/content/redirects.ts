import { repositoryLink } from "./site.ts"

/** One redirect, written in Cloudflare's `_redirects` terms: `*` is a splat, `:splat` its value. */
export interface Redirect {
  readonly source: string
  readonly destination: string
  readonly status: 301 | 302
}

const github = "https://github.com/Rika-Labs/akter/blob/main"

const directory = (path: string): string => repositoryLink({ path, directory: true })

/**
 * Every address that used to answer on docs.akter.dev and now moves. A destination is a
 * published route or an external address; the repository's `docs/` files that are not
 * published go to GitHub.
 */
export const redirects: ReadonlyArray<Redirect> = [
  { source: "/", destination: "/welcome", status: 302 },
  { source: "/quickstart", destination: "/getting-started", status: 301 },
  { source: "/guides/concepts", destination: "/core/actors", status: 301 },
  { source: "/guides/actions-and-jobs", destination: "/core/jobs", status: 301 },
  { source: "/guides/deploy", destination: "/deploy/overview", status: 301 },
  { source: "/guides/comparison", destination: "/why-akter", status: 301 },
  { source: "/guides/effect-into-the-commit", destination: "/core/jobs", status: 301 },
  { source: "/product/fit-and-non-fit", destination: "/why-akter", status: 301 },
  {
    source: "/product/competitive-positioning",
    destination: `${github}/docs/internals/product/competitive-positioning.md`,
    status: 301,
  },
  { source: "/api/01-server-api", destination: "/reference/server", status: 301 },
  { source: "/api/02-context", destination: "/core/commands", status: 301 },
  { source: "/api/03-typescript-sdk", destination: "/guides/client", status: 301 },
  { source: "/api/04-drizzle", destination: "/reference/server", status: 301 },
  { source: "/api/05-generated-clients", destination: "/guides/client", status: 301 },
  { source: "/api/06-cli", destination: "/reference/cli", status: 301 },
  { source: "/api/07-cloud-logs", destination: "/reference/cli", status: 301 },
  { source: "/api/08-cloud-usage", destination: "/reference/cli", status: 301 },
  { source: "/api/09-environment-api-keys", destination: "/reference/cli", status: 301 },
  { source: "/api/forks", destination: "/reference/cli", status: 301 },
  { source: "/api/generated-contracts", destination: "/guides/client", status: 301 },
  { source: "/api/jobs", destination: "/core/jobs", status: 301 },
  { source: "/api/lists-and-find", destination: "/core/lists", status: 301 },
  { source: "/api/naming", destination: "/core/commands", status: 301 },
  { source: "/api/versioning", destination: "/guides/changing-state", status: 301 },
  { source: "/api/post-foundation-sketches", destination: "/reference/server", status: 301 },
  { source: "/operations/self-host", destination: "/deploy/overview", status: 301 },
  { source: "/operations/01-deployment", destination: "/deploy/overview", status: 301 },
  { source: "/operations/02-migrations", destination: "/guides/changing-state", status: 301 },
  { source: "/operations/03-observability", destination: "/guides/operating", status: 301 },
  { source: "/operations/04-backup-restore", destination: "/guides/operating", status: 301 },
  { source: "/operations/inspection-views", destination: "/guides/operating", status: 301 },
  { source: "/operations/retention", destination: "/guides/operating", status: 301 },
  { source: "/operations/runbooks", destination: "/guides/operating", status: 301 },
  { source: "/operations/support-matrix", destination: "/reference/guarantees", status: 301 },
  {
    source: "/operations/alpha-upgrades",
    destination: `${github}/packages/akter/CHANGELOG.md`,
    status: 301,
  },
  {
    source: "/operations/05-releasing",
    destination: `${github}/docs/internals/releasing.md`,
    status: 301,
  },
  { source: "/cloud/get-started", destination: "/welcome", status: 301 },
  { source: "/cloud/storage", destination: "/deploy/overview", status: 301 },
  { source: "/cloud/deploy", destination: "/deploy/overview", status: 301 },
  { source: "/cloud/environment-variables", destination: "/deploy/overview", status: 301 },
  { source: "/cloud/logs", destination: "/guides/operating", status: 301 },
  { source: "/cloud/pricing-and-limits", destination: "/welcome", status: 301 },
  { source: "/cloud/account-and-data", destination: "/welcome", status: 301 },
  { source: "/cloud/bring-your-database", destination: "/deploy/overview", status: 301 },
  { source: "/cloud/choose-postgres", destination: "/deploy/overview", status: 301 },
  { source: "/cloud/database", destination: "/deploy/overview", status: 301 },
  {
    source: "/contracts/02-command-turns",
    destination: `${github}/docs/internals/contracts/02-actions.md`,
    status: 301,
  },
  {
    source: "/contracts/03-transactions",
    destination: `${github}/docs/internals/contracts/03-durability.md`,
    status: 301,
  },
  {
    source: "/contracts/04-receipts",
    destination: `${github}/docs/internals/contracts/03-durability.md`,
    status: 301,
  },
  {
    source: "/contracts/06-storage-ownership",
    destination: `${github}/docs/internals/contracts/06-storage.md`,
    status: 301,
  },
  { source: "/contracts", destination: directory("docs/internals/contracts"), status: 301 },
  { source: "/contracts/", destination: directory("docs/internals/contracts"), status: 301 },
  {
    source: "/contracts/*",
    destination: `${github}/docs/internals/contracts/:splat.md`,
    status: 301,
  },
  { source: "/decisions", destination: directory("docs/internals/decisions"), status: 301 },
  { source: "/decisions/", destination: directory("docs/internals/decisions"), status: 301 },
  {
    source: "/decisions/*",
    destination: `${github}/docs/internals/decisions/:splat.md`,
    status: 301,
  },
  { source: "/milestones", destination: directory("docs/internals/milestones"), status: 301 },
  { source: "/milestones/", destination: directory("docs/internals/milestones"), status: 301 },
  {
    source: "/milestones/*",
    destination: `${github}/docs/internals/milestones/:splat.md`,
    status: 301,
  },
  { source: "/BENCHMARKS", destination: `${github}/docs/internals/benchmarks.md`, status: 301 },
  { source: "/packages", destination: directory("packages"), status: 301 },
  { source: "/packages/", destination: directory("packages"), status: 301 },
  { source: "/packages/*", destination: `${github}/packages/:splat`, status: 301 },
  {
    source: "/architecture/data-model",
    destination: `${github}/docs/internals/architecture/03-storage-layout.md`,
    status: 301,
  },
  {
    source: "/architecture/transaction-catalog",
    destination: `${github}/docs/internals/architecture/04-dispatch.md`,
    status: 301,
  },
  {
    source: "/vision/03-relational-data",
    destination: `${github}/docs/internals/vision/02-product-model.md`,
    status: 301,
  },
]
