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
4. Akter hosts the export on Cloudflare at `https://docs.akter.dev`. The export carries `_redirects` (the redirects ADR 0080 configured, plus `/` to `/welcome`), `_headers`, a `.md` twin of every page, `llms.txt`, `llms-full.txt`, a static search index, a sitemap and `robots.txt`.
5. Colours follow `prefers-color-scheme` in CSS with no script and no saved choice. PolySans is not committed: it is served from `https://akter.dev/fonts/PolySans-variable.woff2` under the family `PolySans Var` with `font-display: optional` and a metric-matched local fallback, and Geist Mono is self-hosted.
6. Mintlify is removed: `docs/docs.json`, `docs/.mintignore`, `docs/style.css` and the Mintlify-only logo files are deleted.

## Consequences

- `bun run --cwd apps/docs build` produces `apps/docs/out`, the whole deploy artifact. No environment variable is required.
- A new public page is added to `navigation.ts`; the build fails if its links or anchors are wrong.
- The first-paint claims are checked by measurement; rerun the matrix in the evidence document when the layout, stylesheet or font source changes.
- Hosting, the `docs.akter.dev` custom domain and the cutover from Mintlify belong to the private Akter Cloud repository.
- The font origin must keep allowing `https://docs.akter.dev` as a CORS origin. Its current `Cache-Control: max-age=0, must-revalidate` makes a cold or revalidating load fall back to the metric-matched face; a long immutable cache on the font would let more loads start with PolySans.

## Alternatives

- **Stay on the hosted platform.** Rejected: the first-paint behaviour is not ours to guarantee, and the earlier measurements failed it before overrides.
- **Host on Vercel.** Rejected: Akter hosts the docs itself on Cloudflare, and a static export needs only a file server with redirects and headers.
- **Copy the pages into the app.** Rejected: two copies drift, and GitHub readers would read different text from the site.
