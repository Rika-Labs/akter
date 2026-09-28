# Docs site

`@durable-actors/docs` renders the published pages under `docs/` into a static site ([ADR 0042](../../docs/decisions/0042-docs-site.md)). The page list and its order are in `src/pages.ts`; contracts, decisions, and every other repository document are linked on GitHub rather than published.

## Build and preview

From `apps/docs`:

- `bun run build` writes `dist/`: an HTML page and a Markdown copy per page, `llms.txt`, and `styles.css`. It fails when a page has no `# ` title or `**Responsibility:**` line, or a relative link leaves the repository.
- `bun run start` serves `dist/` on `PORT` (default 3002). It does not build.
- `bun run dev` builds once, then serves.
- `bun run test` builds the real `docs/` tree and checks every link and heading anchor.

`dist/` is the deployable artifact; serve it from any static host and any base path.
