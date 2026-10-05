# @akter/site

The public website: the home page, pricing, the changelog, the blog and a 404. Astro with static output, styled with StyleX through `@stylexjs/unplugin` in Astro's Vite pipeline. The decision is [ADR 0064](../../docs/decisions/0064-web-front-ends.md).

## Run it

```sh
bun install
bun run --cwd apps/site dev        # http://localhost:4321, or SITE_PORT
bun run --cwd apps/site build      # static site in apps/site/dist
bun run --cwd apps/site preview
bun run --cwd apps/site typecheck  # astro sync, then tsc over the .ts modules
bun run --cwd apps/site lint
bun run --cwd apps/site test
```

## Where things come from

- The palette, hairline and layout measures are in `src/styles/site-tokens.stylex.ts`; the mark and the port drawings' geometry come from `@akter/ui/brand`. `src/illustrations/render-drawing.ts` renders those descriptors to inline SVG with token paints and CSS animation that switches off for `prefers-reduced-motion`.
- The only illustrations are the port scene (`portScene`) and the footer's strip of containers (`containerStrip`), both in `src/illustrations/scenes.ts`. `src/components/art.astro` shows either one whole or cropped by changing the SVG `viewBox`. Figure 1 is `src/components/figure-one.astro`.
- Fonts are `@akter/ui`'s PolySans and Geist Mono, declared with `@font-face` in `src/styles/fonts.ts`.
- The docs are not built here. Mintlify publishes the public pages of the repository's `docs/` directory at `docsUrl` in `src/site.ts` ([ADR 0080](../../docs/decisions/0080-public-docs-on-mintlify.md)); every Docs link on the site points there.
- The crash-test, latency and hot-key numbers on the home page are read from the tables in `BENCHMARKS.md` by `src/benchmarks/report.ts`. If the file is reworded so a table can no longer be found, the build fails instead of showing stale numbers.
- Changelog entries are data in `src/changelog/entries.ts`. Blog posts are listed in `src/blog/posts.ts`; each post is a page under `src/pages/blog/`.
- Styling is colocated: each `.astro` component composes `stylex.attrs(...)` from a `*.styles.ts` module beside it.
- The Open Graph image, favicon and touch icon are drawn from the brand at build time (`src/assets/`).

## Placeholders

`src/site.ts` holds the production URL, the docs URL, the console URL behind Sign in and Start building, and the sales address. They are placeholders until the domain and console exist. Plan prices and usage rates in `src/pricing/` are placeholders until Akter Cloud launches.
