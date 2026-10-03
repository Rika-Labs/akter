# ADR 0080: Public docs on Mintlify

**Status:** accepted (2026-10-03, Dallen).

**Responsibility:** decide where Akter's public documentation is published and what the website does with it.

**Authority:** design decision record.

**Owner role:** documentation.

**Change policy:** supersede through a new ADR.

## Context

[ADR 0064](0064-web-front-ends.md) made `apps/site` the public website, and the site rendered the repository's public docs itself at `/docs/**`, with a raw Markdown copy of each page, `/llms.txt`, `/llms-full.txt` and a search index, through its own Markdown pipeline (an Astro content collection, a remark renderer, link rewriting and a docs layout). Hosted docs platforms give search, an AI assistant, per-page Markdown, `llms.txt` and analytics without that code. Issue [#549](https://github.com/Rika-Labs/akter/issues/549).

## Decision

1. The public docs are published with [Mintlify](https://mintlify.com) at `https://docs.akter.dev`. Its configuration lives in the existing `docs/` directory: `docs/docs.json` (navigation, brand colours, logo, favicon, redirects), `docs/.mintignore`, `docs/style.css`, and the logo and favicon under `docs/`. No new top-level directory.
2. Only the public pages are published: the quickstart, concepts, fit and non-fit, the guides (Effect into the commit, testing, deploy), the API reference and the comparison. `docs/.mintignore` excludes everything else, so decisions, contracts, architecture, operations, verification, vision and other internal documents are never built. Links from a published page to an unpublished document redirect to that file on GitHub.
3. Pages stay plain Markdown that reads correctly on GitHub. They gain only Mintlify frontmatter (`title`, `sidebarTitle`, `description`); their headings and document headers are unchanged.
4. Mintlify serves `llms.txt`, each page's Markdown and search, so the repository does not reproduce them.
5. `apps/site` no longer renders docs. Every Docs link on the site points to the Mintlify URL, which is defined once in `apps/site/src/site.ts`.

## Consequences

- The site's docs routes, its Markdown pipeline and their tests are deleted, with the dependencies only they used (`remark-gfm`, `remark-parse`, `unified`, `@types/mdast`), and the site's build no longer depends on `docs/**`.
- A new public page is added to `docs/docs.json` navigation and allowed in `docs/.mintignore`; an internal document needs neither.
- Publishing depends on the Mintlify project: the GitHub repository connected with `docs/` as the docs root, and the `docs.akter.dev` custom domain.

## Alternatives

- **Keep rendering docs in `apps/site`.** Rejected: it duplicates what a docs platform provides and keeps a Markdown pipeline to maintain.
- **A separate docs repository or top-level directory.** Rejected: the docs already live in `docs/` beside the code they describe, and Mintlify reads a subdirectory.
