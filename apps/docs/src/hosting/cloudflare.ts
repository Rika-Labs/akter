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

const SHORT_LIVED = "Cache-Control: public, max-age=0, must-revalidate, no-transform"

const IMMUTABLE = "Cache-Control: public, max-age=31536000, immutable, no-transform"

const rule = (path: string, headers: ReadonlyArray<string>): string =>
  [path, ...headers.map((header) => `  ${header}`)].join("\n")

/**
 * The content security policy of every response. The export is static, so nothing is fetched
 * from any origin but the page's own: both fonts are files of the export, and no page, style or
 * script names a `data:` URL, so images and fonts allow `'self'` and nothing else. Scripts
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
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ")

/**
 * The `_headers` file. Every response carries the security headers of Akter's other
 * websites. The default revalidates and forbids edge transformations so HTML and unknown 404
 * responses retain the approved export's payload. Hashed build assets detach that default
 * cache header before keeping their one-year immutable policy; otherwise Cloudflare would
 * join the two cache policies. Markdown twins keep their content type. No other rule repeats
 * a security header, since Cloudflare joins repeated values and browsers enforce every policy.
 */
export const renderHeaders = (): string =>
  [
    rule("/*", [
      SHORT_LIVED,
      "Strict-Transport-Security: max-age=63072000; includeSubDomains",
      "X-Content-Type-Options: nosniff",
      "X-Frame-Options: DENY",
      "Referrer-Policy: no-referrer",
      "Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()",
      `Content-Security-Policy: ${contentSecurityPolicy()}`,
    ]),
    rule("/_next/static/*", ["! Cache-Control", IMMUTABLE]),
    rule("/*.md", ["Content-Type: text/markdown; charset=utf-8"]),
  ]
    .join("\n\n")
    .concat("\n")
