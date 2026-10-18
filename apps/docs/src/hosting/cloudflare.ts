import type { Redirect } from "../content/redirects.ts"

/**
 * The `_redirects` file: one rule per line, in the order given. Cloudflare applies the first
 * rule that matches, so the caller lists a static rule before a splat rule that would also
 * match it.
 */
export const renderRedirects = (redirects: ReadonlyArray<Redirect>): string =>
  redirects
    .map((redirect) => `${redirect.source} ${redirect.destination} ${redirect.status}`)
    .join("\n")
    .concat("\n")

const SHORT_LIVED = "Cache-Control: public, max-age=0, must-revalidate"

const IMMUTABLE = "Cache-Control: public, max-age=31536000, immutable"

const rule = (path: string, headers: ReadonlyArray<string>): string =>
  [path, ...headers.map((header) => `  ${header}`)].join("\n")

/**
 * The content security policy of every response. The export is static, so nothing is fetched
 * from any origin but the page's own; both fonts are `data:` URLs in the stylesheet. Scripts
 * allow `'unsafe-inline'` because Next writes the page's data and bootstrap into inline
 * scripts, and a page carries dozens of them: a hash for each would overrun the 2,000
 * character limit of a header line. Styles allow it because React and the code highlighter
 * write `style` attributes.
 */
export const contentSecurityPolicy = (): string =>
  [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ")

/**
 * The `_headers` file. Every response carries the security headers of Akter's other
 * websites. Hashed build assets never change, so they cache for a year. Every page, the
 * Markdown twins, the search index and `llms.txt` revalidate on each visit, so a deploy shows
 * at once. Cache rules name pages one by one because a header rule on `/*` would also match
 * the immutable assets and merge with theirs; for the same reason no other rule repeats a
 * security header, since Cloudflare joins a repeated header and browsers enforce every policy.
 */
export const renderHeaders = (input: { readonly pagePaths: ReadonlyArray<string> }): string =>
  [
    rule("/*", [
      "Strict-Transport-Security: max-age=63072000; includeSubDomains",
      "X-Content-Type-Options: nosniff",
      "X-Frame-Options: DENY",
      "Referrer-Policy: no-referrer",
      "Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()",
      `Content-Security-Policy: ${contentSecurityPolicy()}`,
    ]),
    rule("/_next/static/*", [IMMUTABLE]),
    ...input.pagePaths.map((path) => rule(path, [SHORT_LIVED])),
    rule("/*.md", ["Content-Type: text/markdown; charset=utf-8", SHORT_LIVED]),
    rule("/llms.txt", [SHORT_LIVED]),
    rule("/llms-full.txt", [SHORT_LIVED]),
    rule("/search.json", [SHORT_LIVED]),
    rule("/sitemap.xml", [SHORT_LIVED]),
    rule("/robots.txt", [SHORT_LIVED]),
    rule("/favicon.svg", [SHORT_LIVED]),
  ]
    .join("\n\n")
    .concat("\n")
