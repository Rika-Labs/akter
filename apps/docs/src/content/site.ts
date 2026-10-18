/** Public origin of the documentation site; canonical URLs, the sitemap and `llms.txt` use it. */
export const siteUrl = "https://docs.akter.dev"

export const siteName = "Akter"

export const siteDescription =
  "The framework for durable actors, deterministic actions, journaled jobs, realtime state, and bucket-backed stores."

export const marketingUrl = "https://akter.dev"

export const signInUrl = "https://app.akter.dev/sign-in"

export const repositoryUrl = "https://github.com/Rika-Labs/akter"

export const repositoryBranch = "main"

/** The GitHub address of a repository path; directories use `tree`, everything else `blob`. */
export const repositoryLink = (input: {
  readonly path: string
  readonly directory: boolean
}): string =>
  `${repositoryUrl}/${input.directory ? "tree" : "blob"}/${repositoryBranch}/${input.path}`

/** The font file Akter serves with CORS for the docs origin. */
export const polySansUrl = "https://akter.dev/fonts/PolySans-variable.woff2"
