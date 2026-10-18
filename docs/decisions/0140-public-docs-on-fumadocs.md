# ADR 0140: Public docs on Fumadocs, hosted by Akter

**Status:** accepted (2026-10-17, Dallen); supersedes [ADR 0080](0080-public-docs-on-mintlify.md).

**Responsibility:** decide how Akter's public documentation is built and where it is hosted.

**Authority:** design decision record.

**Owner role:** documentation.

**Change policy:** supersede through a new ADR.

## Context

[ADR 0080](0080-public-docs-on-mintlify.md) published the public pages through a hosted docs platform. The platform owned theme selection, font loading and page rendering, so the repository could not guarantee what the first paint shows. An earlier evidence round on the hosted platform recorded a light page under a dark system preference and a title that changed width after the first contentful paint, and fixing those needed overrides on top of a renderer the repository does not own. Dallen's rule for the docs is that the page is server-rendered and complete on first paint: no theme flash, no layout shift on refresh, no late font swap and no entrance animation.

## Decision

1. The public docs are a static Next.js export built with Fumadocs in `apps/docs` (`@akter/docs`). It is a private workspace app and publishes nothing to npm.
2. The app reads the Markdown under `docs/` in place; no page is copied or moved, and the pages keep reading correctly on GitHub. `apps/docs/src/content/navigation.ts` is the only list of published pages and tabs, so a document is published only when it is listed there. Decisions, contracts, architecture, operations internals, verification and vision stay unpublished.
3. Links are resolved at build time. A link to a published page becomes its route, a link to another repository file becomes a GitHub URL, and a missing page or heading fails the build.
4. Akter hosts the export on Cloudflare at `https://docs.akter.dev`. The export carries `_redirects` (the redirects ADR 0080 configured, plus `/` to `/welcome`), `_headers`, a `.md` twin of every page, `llms.txt`, `llms-full.txt`, a static search index, a sitemap and `robots.txt`. `_headers` sends `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` and a `Content-Security-Policy` that matches the hosting platform's own policy, with two differences: `script-src` allows `'unsafe-inline'` because Next writes inline data and bootstrap scripts into every page (up to 30 on one page, so hashing them would exceed Cloudflare's 2,000-character header line), and `font-src` allows `data:` because the font is embedded in the stylesheet.
5. Colours follow `prefers-color-scheme` in CSS with no script and no saved choice. PolySans is not committed: the build fetches it from `<FONT_ORIGIN>/fonts/PolySans-variable.woff2` (`https://akter.dev` unless the build sets it), or reads the file named by `POLYSANS_FILE`, and embeds it in the render-blocking stylesheet as a `data:` URL under the family `PolySans Var` with `font-display: optional` and a metric-matched local fallback. A font requested after the first paint reached WebKit too late: it painted the fallback and reflowed when PolySans arrived, in 38 of 40 cold loads with a font origin at 90 ms. The page therefore starts hidden by an attribute on `html` that a small inline script removes once the font is decoded, when loading it fails, or after 1.5 s, and a `noscript` style shows the page without a script. Geist Mono is self-hosted.
6. The build is reproducible. The Next build id is the commit being built, and syntax highlighting has no time limit, so a loaded machine cannot cut a code line into fewer tokens. `bun run --cwd apps/docs check:reproducible` builds twice, the second time with every CPU busy, and fails if the two exports differ by one byte.
7. Mintlify is removed: `docs/docs.json`, `docs/.mintignore`, `docs/style.css` and the Mintlify-only logo files are deleted.

## Consequences

- `bun run --cwd apps/docs build` produces `apps/docs/out`, the whole deploy artifact. Two optional build settings name the origins: `SITE_URL` (default `https://docs.akter.dev`) is used for canonical links, the sitemap, `robots.txt`, `llms.txt`, the Markdown twins and the page actions, and `FONT_ORIGIN` (default `https://akter.dev`) names the origin the build fetches the font from. Each must be a bare `https://` origin, and the build fails if the production site address is still in the export when `SITE_URL` is overridden or if the export still names a font file. The build runs inside a git checkout because the build id is the commit, and it needs the font: three tries against the font origin or `POLYSANS_FILE`, and the build stops with a message naming both when neither works, because a site that ships without its face is worse than a failed deploy.
- A new public page is added to `navigation.ts`; the build fails if its links or anchors are wrong.
- The first-paint claims are checked by measurement; rerun the matrix in the evidence document when the layout, stylesheet or font source changes.
- Hosting, the `docs.akter.dev` custom domain and the cutover from Mintlify belong to the private Akter Cloud repository.
- The font travels inside the stylesheet, about 127 KB of text that adds roughly 95 KB of font bytes to the first load and nothing after it: the stylesheet is hashed and cached for a year, so the font no longer revalidates on each visit, and the font origin needs no CORS grant for the docs origin. The first paint waits for the stylesheet, so it waits for the font.

## Alternatives

- **Stay on the hosted platform.** Rejected: the first-paint behaviour is not ours to guarantee, and the earlier measurements failed it before overrides.
- **Host on Vercel.** Rejected: Akter hosts the docs itself on Cloudflare, and a static export needs only a file server with redirects and headers.
- **Copy the pages into the app.** Rejected: two copies drift, and GitHub readers would read different text from the site.
