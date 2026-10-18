const ORIGIN = /^https:\/\/[a-z0-9.-]+$/

/**
 * Reads an origin build setting: `value` when set, else `fallback`. An origin is `https://`
 * and a host with no port, path or trailing slash, so a typo fails the build instead of
 * baking a broken address into every page.
 */
export const originFrom = (input: {
  readonly name: string
  readonly value: string | undefined
  readonly fallback: string
}): string => {
  const origin = input.value ?? input.fallback

  if (!ORIGIN.test(origin))
    throw new Error(
      `${input.name} must be an https origin such as ${input.fallback}, got "${origin}"`,
    )

  return origin
}

/** The origin the production site is served from, used when `SITE_URL` is unset. */
export const defaultSiteUrl = "https://docs.akter.dev"

/**
 * Public origin of the documentation site, set with `SITE_URL`; canonical URLs, the sitemap,
 * `robots.txt`, `llms.txt` and the Markdown twins use it.
 */
export const siteUrl = originFrom({
  name: "SITE_URL",
  value: process.env["SITE_URL"],
  fallback: defaultSiteUrl,
})
