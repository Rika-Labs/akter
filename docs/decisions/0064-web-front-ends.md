# ADR 0064: Web front ends: an Astro marketing site, a FoldKit console, one StyleX design system

**Status:** accepted (2026-10-02, Dallen).

**Responsibility:** decide how Akter's public website and its hosted product console are built, and what they share.

**Authority:** design decision record.

**Owner role:** product web.

**Change policy:** supersede through a new ADR.

## Context

Akter needs a public website (landing, docs, examples, benchmarks, pricing) and a product console for the hosted service (sign-in, overview, actors, commands, jobs, workflows, connections, deployments, settings, billing). The visual direction was settled with Dallen on 2026-10-02: Rika Labs colours (stone `#f5f5f4`, ink `#0b0d0b`), the segmented Ak mark, line-art shipping containers because an actor is a container, a restrained style with small radii and few badges, and a console modelled on the Capy app's layout and settings.

`apps/console` is a server-rendered FoldKit template ("Forma") with placeholder pages, and `@akter/ui` holds its StyleX tokens. The team's `In-Time-Tec/whorl` web app shows the intended product architecture: a FoldKit client application built with Vite, StyleX through `@stylexjs/unplugin`, semantic tokens, and a shadcn-style library of components and variants.

## Decision

1. `apps/site` (`@akter/site`) is the public website, built with Astro as static output. Styling is StyleX through `@stylexjs/unplugin` in Astro's Vite pipeline; Astro components compose `stylex.attrs(...)` from colocated `*.ts` style modules. No Tailwind, no global utility CSS beyond a reset and font faces.
2. `apps/console` becomes the product console: a FoldKit application built with Vite, `@foldkit/vite-plugin` and `@stylexjs/unplugin`, following the whorl web app's structure (app routes with model/update/view, a design directory, shared components). Every page renders from typed fixtures until the hosted API exists; fixtures live beside the client that will replace them and are never shipped as production data.
3. `@akter/ui` is the shared design system. It owns the semantic StyleX tokens (`tokens.stylex.ts`), the shadcn-style FoldKit components and their variants, chart and diagram views, and framework-free brand geometry (the mark and the container illustrations) that both the site and the console render. Components consume semantic roles, never palette values; callers control placement, not appearance.
4. Charts and diagrams are SVG drawn from data by `@akter/ui` code, not a charting dependency, so they inherit tokens and print crisply.
5. Brand fonts (PolySans, Sagittaire Display) are served from `@akter/ui` assets. The site uses Sagittaire for display headings; the console uses PolySans only. Their licence must cover Akter's domains before the site is public.

## Consequences

- The console's old SSR form handlers and fixture pages are replaced; `apps/e2e` follows the new console.
- `@akter/ui` is consumed as TypeScript source by both apps' StyleX compilers, so its Babel-to-`dist` build is retired.
- Billing screens describe Stripe (decided separately); no provider SDK enters the front ends.

## Alternatives

- **One app for site and console.** Rejected: the site must be static, fast and crawlable, while the console is an authenticated client application.
- **Tailwind.** Rejected: StyleX gives typed, compiled tokens shared by both apps, and the repository already uses it.
- **A charting library.** Rejected: the charts are few, must match the brand exactly, and are simpler as owned SVG.
