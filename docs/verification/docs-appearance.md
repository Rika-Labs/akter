# Docs appearance and font-loading evidence

**Responsibility:** bound the public documentation theme, navigation and font-loading claims.

**Authority:** evidence.

**Owner role:** documentation.

**Change policy:** rerun the rendering matrix when the Mintlify configuration, stylesheet or font source changes.

## Implementation boundary

The public site remains Mintlify, configured in `docs/docs.json` and `docs/style.css`. No framework contract or API changes. Only the docs navbar loses Blog and Changelog; GitHub and Sign in retain their destinations. The yellow icon and favicon are unchanged. The dark logo copies the light logo's geometry and changes only the wordmark fill.

Mintlify's [supported font source](https://www.mintlify.com/docs/customize/fonts) configures `PolySans` from `https://akter.dev/fonts/PolySans-variable.woff2` and generates an early cross-origin font preload. Commercial font binaries are not stored in this public repository. The existing open-source Geist Mono asset remains local.

CSS deliberately consumes the distinct `PolySans Var` face, with the variable weight range and `font-display: optional`. Mintlify's generated `PolySans` face uses `swap` at regular weight in the tested CLI. Giving both faces the same name let regular body text select that generated face and swap late, even though headings were stable. Keeping the names distinct preserves the supported preload without consuming the generated swapping face. Geist Mono also uses `optional`.

An optional face can render in its short initial block period; otherwise the browser retains readable fallback text for that page load instead of swapping late. A slow or failed font is not promised to display PolySans. There is no JavaScript theme/font gate and no new content-hiding rule.

Mintlify owns system preference and saved theme choice. Its `.dark` class selects the CSS surface, prose, navigation and syntax tokens. Sign in keeps dark text on the yellow button in both themes. Paragraph tokens cover both ordinary `p` elements and Mintlify's `data-as="p"` rendering.

## Commands and method

Local evidence was collected on 2026-10-10 UTC with the pinned npm package `mint@4.2.997`, Chromium 155, Bun 1.4.2 and Node 26.10.0 in a Linux x64 orb. The CLI's `--version` printed `unknown`; the installed package manifest confirmed 4.2.997.

From the repository root:

```sh
bun install --frozen-lockfile
bun run format:check
bun run lint:structure
bun run lint:directives
git diff --check
```

From `docs/`:

```sh
npx -y mint@4.2.997 validate
npx -y mint@4.2.997 dev --port 3000 --no-open --telemetry false
```

The dev server was a supervised `amp orb service`, not a replacement renderer. Browser automation used Playwright connected to agent-browser's Chromium. Screenshots are 1440 × 900 CSS pixels at DPR 2, and narrow-layout captures are 390 × 844 at DPR 2. They are desktop Chromium, not physical-phone or touch evidence.

Two complementary runs exercised the real local preview:

1. Fresh contexts for each OS theme and font delay, with browser caching disabled, followed by cache clearing and a full reload. The same 1200 ms font-response delay reproduced the baseline swap and tested the fix. The live PolySans response was fetched into memory; only CORS was adapted for the local origin. No commercial font bytes were written into the checkout. Frame-by-frame text ranges measured the title, body paragraph, monospace label and code line before and after the font responses completed. FontFace status and CDP's actual rendered-font report supplied independent loading evidence.
2. Requests for `https://docs.akter.dev` were routed to the local Mintlify server, while font requests to `akter.dev` were unmodified live HTTPS requests. This preserved the actual documentation Origin and tested the endpoint's real CORS response without altering font headers or bytes. It is still a local-renderer test, not a hosted Mintlify test.

## Observations

| Case                                  | Baseline                                                                | Changed local preview                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| System-dark, fresh context and reload | Light mode despite dark OS preference                                   | Dark page, navigation, wordmark and code; system-light remains light                                                                                   |
| 1200 ms font delay, both themes       | Title changes from 190.28 to 174.56 CSS px after first contentful paint | Title stays 190.28; zero late geometry changes in title, body, label and code on initial load and cold refresh, despite both font responses completing |
| Prompt font delivery                  | PolySans eventually replaces fallback                                   | Mintlify preloads PolySans; CDP confirms PolySansVariable actually renders headings and body in both themes                                            |
| Navigation                            | Blog, Changelog, GitHub and Sign in                                     | Blog/Changelog absent; GitHub and Sign in visible with unchanged URLs                                                                                  |
| Live font endpoint with docs Origin   | Not a baseline comparison                                               | HTTP 200, `font/woff2`, `Access-Control-Allow-Origin: https://docs.akter.dev`; real PolySans glyphs rendered after cold refresh                        |
| OS preference changes while open      | Not exercised on baseline                                               | System choice follows both directions; explicit Light survives reload and selecting System restores OS-dark                                            |
| Font request denied                   | Not exercised on baseline                                               | Title and body remain visible and theme controls still work                                                                                            |
| Narrow layout                         | Not a baseline comparison                                               | Both themes render at DPR 2 without document-wide horizontal overflow                                                                                  |

The primary matrix passed eight initial-load/reload observations across the two themes and the prompt/1200 ms font cases. All four delayed observations retained identical measured geometry when the fonts finished. The supplemental live-endpoint run passed both themes and cold refreshes, logo selection, navigation, dynamic OS changes, saved choice and denied-font controls.

Sampled computed colors, composited against their actual backgrounds, gave body contrast 11.37:1 in light and 13.46:1 in dark, muted navigation 5.44:1 and 8.09:1, code text 17.12:1 and 16.95:1, and Sign in 12.13:1 in both modes. These are sample measurements, not a site-wide accessibility certification.

Mint validation reported `success build validation passed`. The repository-wide formatting, structure and directive checks and `git diff --check` passed. No runtime suite was needed for this docs-only change.

## Review evidence and limits

The [implementation thread](https://ampcode.com/threads/T-01a12345-1a5a-7456-8a4c-ac1c5b62a0a4) contains inspected screenshots and the command results. Review artifacts are under `.amp/in/artifacts/docs-appearance/` in that thread's workspace:

- `final-light.png`, `final-dark.png`: default quickstart after cold refresh, with live font delivery.
- `final-light-code.png`, `final-dark-code.png`: TypeScript code and nearby prose.
- `final-light-narrow.png`, `final-dark-narrow.png`: narrow layouts.
- `before-evidence.json`, `final-evidence.json`, `flows-evidence.json`: baseline, timing/geometry and live-endpoint observations.

Long code lines retain Mintlify's horizontal scroller. The inspected install block scrolled from 0 to its 138 CSS px maximum without overflowing the document. The pre-existing local preview floating control remains visible in captures, including its overlap at narrow widths; no provider-owned controls were hidden for screenshots.

An initial harness teardown interrupted an outstanding local preview socket poll, and a denied-font locator initially matched multiple paragraphs. Those runs were not treated as complete passes; cleanup and the locator were corrected before the full run passed.

The endpoint currently allows the docs Origin, not localhost or an orb portal Origin; an ordinary local preview may therefore use fallback text. Native `optional` behavior can also keep a slow monospace font on fallback for that load. Neither result is a content gate.

Hosted Mintlify rendering, provider preprocessing/CDN behavior, production cold-refresh timing, other browser engines, and hosted search are unverified. No merge, deployment, production setting or font-origin policy was changed by this work.
