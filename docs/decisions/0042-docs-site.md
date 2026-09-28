# ADR 0042: The docs site, its Markdown copies, and `llms.txt`

**Status:** proposed (2026-09-28).

**Responsibility:** decide where the docs site lives, what it publishes, how it is built, and what stays in the repository.

**Authority:** design decision record.

**Owner role:** documentation.

**Change policy:** supersede through a new ADR.

## Context

CR.3 ([#87](https://github.com/Rika-Labs/durable-actors/issues/87)) asks for a static site built from `docs/api`, with guides, an `llms.txt`, a Markdown copy of each page, and a comparison page, while contracts and ADRs stay in the repository and are linked. [Repository structure](../architecture/repository-structure.md) says a new workspace package needs an ADR. Nothing in the repository renders Markdown today; Bun 1.4.2, which every workspace runs on, ships `Bun.markdown` with GitHub-flavoured tables and GitHub-compatible heading ids.

## Decision

- **Package.** `apps/docs` is `@durable-actors/docs`, a private app. It is deployable output (a directory of static files), so it belongs in `apps/*`, and no package imports it. It adds no dependency beyond `effect` and `@effect/platform-bun`.
- **Sources.** Pages are Markdown files under `docs/`, listed in reading order in `apps/docs/src/pages.ts`: the home page `docs/guides/README.md`, the [quickstart](../quickstart.md), every page in `docs/api/`, and the guides in `docs/guides/`. The site has no content of its own, so a page reads the same on GitHub and on the site. Every published page opens with a `# ` title and a `**Responsibility:**` line; the build fails without them, because the line is the page's description.
- **What stays in the repository.** Contracts, architecture, decisions, verification, operations, milestones, and research are not published. A link from a published page to any other repository path, including a contract or an ADR, is rewritten to that file on GitHub (`blob/main`), and the sidebar links their indexes under "In the repository".
- **Output.** `bun run --cwd apps/docs build` writes `apps/docs/dist/`: for each page an HTML file at its `docs/`-relative path (the home page at `index.html`) and its Markdown copy at the same path with `.md`, plus `llms.txt` and `styles.css`. Links between published pages stay relative, so the directory can be served from any base path. HTML is rendered with `Bun.markdown.html` and heading ids on, so a `#fragment` that works on GitHub works on the site. There is no client JavaScript.
- **Markdown copies.** A copy is the source Markdown with its links rewritten: a published page links to its sibling `.md` copy, and everything else to GitHub. Each HTML page links its copy in the footer and in `<link rel="alternate" type="text/markdown">`.
- **`llms.txt`.** The site root serves an [`llms.txt`](https://llmstxt.org) with the project summary, one list per sidebar section linking each page's Markdown copy with its responsibility line, and an "Optional" list of the repository indexes. It is a file of the docs site, not a framework feature.
- **Serving.** `bun run --cwd apps/docs start` serves `dist/` with Bun (`PORT`, default 3002) for previews; it is not the production host. Choosing a host and a domain is out of scope for CR.3.
- **Evidence.** `apps/docs/src/build.test.ts` builds the real `docs/` tree and fails on any local link or `#fragment` in an HTML page that has no target, on a GitHub link to a repository path that does not exist, on any Markdown copy or `llms.txt` link that is neither a published copy nor external, and on a contract or decision published as a page. Turbo reruns the docs build and test when anything under `docs/` changes.

## Alternatives

- **A documentation framework (VitePress, Astro Starlight, Docusaurus).** Each adds a large dependency tree and its own Markdown dialect for a site that is a sidebar and rendered Markdown. `Bun.markdown` is already installed and renders GitHub's dialect.
- **Rendering with the console's FoldKit and StyleX stack.** The console is a server-rendered app with forms and sessions; static documentation needs neither, and coupling the two builds would make doc changes rebuild the UI package.
- **Publishing contracts and ADRs on the site.** They are normative and historical records that change with code review; publishing them would make the site a second place to read them and invite divergent copies. Linking to GitHub keeps one source.
- **Serving Markdown copies at `<page>.html.md`, as llmstxt.org suggests for URLs with a file name.** The same path with `.md` mirrors the repository layout and is what `llms.txt` links, so agents do not need to guess.

## Consequences

- Adding a page means adding it to `pages.ts`; a Markdown file under `docs/` that is not listed stays repository-only.
- A link in a published page to a missing page, heading, or repository file fails `bun run check`. Fragments of links to GitHub are not checked.
- The site has no search and no syntax highlighting.

## Revisit when

- The site needs search, versioned docs per release, or a production host, or a page needs interactive content.
