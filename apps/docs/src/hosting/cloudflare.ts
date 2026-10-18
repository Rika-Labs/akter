import type { Redirect } from "../content/redirects.ts"

/** The `_redirects` file: one rule per line, static rules before the splat rules that follow them. */
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
 * The `_headers` file. Hashed build assets never change, so they cache for a year. Every
 * page, the Markdown twins, the search index and `llms.txt` revalidate on each visit, so a
 * deploy shows at once. Cache rules name pages one by one because a header rule on `/*`
 * would also match the immutable assets and merge with theirs.
 */
export const renderHeaders = (pagePaths: ReadonlyArray<string>): string =>
  [
    rule("/*", [
      "X-Content-Type-Options: nosniff",
      "Referrer-Policy: strict-origin-when-cross-origin",
      "X-Frame-Options: DENY",
    ]),
    rule("/_next/static/*", [IMMUTABLE]),
    ...pagePaths.map((path) => rule(path, [SHORT_LIVED])),
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
