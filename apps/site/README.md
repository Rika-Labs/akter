# @akter/site

The public website: landing, examples, benchmarks, pricing and a 404. Astro with static output, styled with StyleX through `@stylexjs/unplugin` in Astro's Vite pipeline. The decision is [ADR 0064](../../docs/decisions/0064-web-front-ends.md).

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

- Tokens and the segmented mark come from `@akter/ui`: `@akter/ui/tokens.stylex` for colours, space, type, radius, shadows and motion, and `@akter/ui/brand` for the mark and the container, quay, water, crane and stack geometry. `src/illustrations/render-drawing.ts` renders those descriptors to inline SVG with token paints and CSS animation that switches off for `prefers-reduced-motion`. The scenes and glyphs the site adds on top live in `src/illustrations/`.
- Fonts are `@akter/ui`'s PolySans, Sagittaire Display and Geist Mono, declared with `@font-face` in `src/styles/fonts.ts`.
- The docs are not built here. Mintlify publishes the public pages of the repository's `docs/` directory at `docsUrl` in `src/site.ts` ([ADR 0080](../../docs/decisions/0080-public-docs-on-mintlify.md)); every Docs link on the site points there.
- The benchmark charts read the tables in `BENCHMARKS.md`, and the landing page's code is the README's Order example. If either file is reworded so a table or code block can no longer be found, the build fails instead of showing stale numbers.
- Styling is colocated: each `.astro` component composes `stylex.attrs(...)` from a `*.styles.ts` module beside it.
- The Open Graph image, favicon and touch icon are drawn from the brand at build time (`src/assets/`).

## Placeholders

`src/site.ts` holds the production URL, the docs URL, the console URL behind Sign in and Start building, and the sales address. They are placeholders until the domain and console exist. Plan prices and usage rates in `src/pricing/` are placeholders until Akter cloud launches.
