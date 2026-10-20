# Docs appearance and first-paint evidence

**Responsibility:** bound the public documentation's first-paint, theme, navigation, font-loading, scroll-restoration, keyboard and reference-match claims.

**Authority:** evidence.

**Owner role:** documentation.

**Change policy:** rerun the measurement matrix below when `apps/docs` layout, its stylesheet, the Fumadocs version, the fonts or the scroll-restore script change, and rerun the parity comparison when the reference site changes.

## Claims

The public docs are the static export of `apps/docs`. The page the browser receives is complete: every element a reader sees on first paint is in the server-rendered HTML.

1. The theme follows `prefers-color-scheme` until the reader picks Light or Dark in the Appearance menu, and a pick is applied before the first paint. No frame shows the other theme, and the page and panel backgrounds each take one value during a load.
2. After the first paint no element moves by more than 0.5 px, changes size, or fades, on a load or a refresh, including a refresh of a page scrolled to its middle, and including loads where the page scripts are slow or never arrive, the stylesheet is slow, or a font file is slow.
3. A late font never swaps in. Inter and Geist Mono are hashed files of the export with a preload link on every page and `font-display: optional`. A face that is there for the first paint is used; one that is not is skipped for that page load, and the fallback faces have the faces' metrics, so no line changes width afterwards.
4. Nothing animates in on load: no entrance transition, no hydration-time swap of visible text.
5. A reload or a back or forward visit puts the page at the offset it was left at, before the first paint with scripts on and by the browser itself with scripts off, with one exception recorded under "Not verified".
6. The menus and the drawer are operable by keyboard: arrow keys move through a menu and wrap, Escape closes it and gives focus back to its button, and the drawer holds focus, makes the page behind it inert and gives focus back when it closes.
7. The shell matches docs.capy.ai measurement for measurement in Akter's colours; every remaining difference is Capy's own content or brand, a sub-pixel difference in a redrawn glyph, or an implementation detail that cannot be seen.

## Environment and method

Collected on 2026-10-19 and 2026-10-20 on macOS 26.6.2 (arm64), Google Chrome 155.0.8059.85 and Playwright's WebKit 26.6, both driven by Playwright 1.63.0, Bun 1.4.2, Node 26.7.0, Next.js 16.4.2 and fumadocs-ui 16.17.5, on the working tree that became the commit that holds this file. The export was served by a small static server (appendix) that applies `_redirects` and `_headers`, so the policy was in force for the measurements; a second instance of it gzips text files, as Cloudflare does.

The no-shift harness (appendix) records every animation frame from document start until 2.4 s after the load. In each frame it reads the rectangle and the effective opacity of every `h1` to `h4`, `p`, `li`, `a`, `button`, `header`, `nav`, `aside`, `main`, `footer`, `img`, `pre`, `table`, `svg`, `kbd` and `input`, keyed by order, tag and visible text, in page coordinates (the document is the scroll container; fixed and sticky elements are read in viewport coordinates), and skips elements that are `visibility: hidden`. It also records the `html` and panel backgrounds, the window's scroll offset, the fonts' load state, the paint timing entries, `layout-shift` entries and `securitypolicyviolation` events. A scenario passes only if all of the following hold from the first frame with content on (the first frame at or after the first-paint entry, or the first frame with content where an engine reports none): no element differs from its settled rectangle by more than 0.5 px, none changes opacity, none appears inside the viewport later, the layout-shift total is 0, each background takes one value, the window's scroll offset takes one value equal to the offset before the reload on a mid-page reload, no policy violation or page error is raised, and the document was never held hidden by a script. Each scenario also checks that the real Inter and Geist Mono were used, by comparing the width of a probe string in each face with its fallback; the scenarios that delay a font file expect the opposite.

The matrix is the product of: engines Chromium and WebKit; pages `/welcome`, `/quickstart` and `/api/01-server-api`; viewports 1440 × 900 and 390 × 844; schemes dark and light; and seven conditions:

| Condition    | What it does                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `cold`       | A fresh browser context, so nothing is cached.                                                                                             |
| `warm`       | The page is visited, then reloaded.                                                                                                        |
| `mid`        | The page is visited, scrolled to the middle of its scroll range, then reloaded; the offset must be the same on the first frame.            |
| `opposite`   | The reader's saved choice is the opposite of the system scheme.                                                                            |
| `no-page-js` | Every script element is removed from the document, so the main thread is at rest, which is when a browser paints earliest.                 |
| `css-delay`  | Every stylesheet is answered after 2.2 s.                                                                                                  |
| `cpu4`       | Chromium with the CPU throttled four times (the WebKit rows repeat the plain load, because Playwright has no throttle control for WebKit). |

A further condition, `font-delay`, answers every font file after 3 s. The interaction attacks (appendix) run beside the matrix and are listed under "Keyboard and behaviour".

## Results

| Run                                             | Engine   | Scenarios | Failing | Frames recorded | Moved or resized elements | Fades | Late in viewport | Layout shift | Policy violations |
| ----------------------------------------------- | -------- | --------- | ------- | --------------- | ------------------------- | ----- | ---------------- | ------------ | ----------------- |
| Seven conditions, export served as built        | Chromium | 84        | 0       | 12,250          | 0                         | 0     | 0                | 0            | 0                 |
| Seven conditions, export served as built        | WebKit   | 84        | 0       | 12,286          | 0                         | 0     | 0                | 0            | 0                 |
| `font-delay`, every font file answered 3 s late | Both     | 24        | 0       | 7,642 (content) | 0                         | 0     | 0                | 0            | 0                 |
| `mid` over gzip, as Cloudflare serves it        | WebKit   | 12        | 0       | 1,742           | 0                         | 0     | 0                | 0            | 0                 |

At 1440 px wide the page is the darker surface and the panel sits on it; at 390 px wide the page is the panel. Each scenario saw one value of each background, and none saw white in dark. First content appeared between 37 and 82 ms after navigation start in Chromium and between 11 and 86 ms in WebKit (cold, warm, mid, opposite and no-page-js); Chromium at four times the CPU cost took 119 to 155 ms. With the stylesheet held for 2.2 s the first frame with content came at 2.22 to 2.25 s in both engines and nothing before it had content, so a slow stylesheet delays the page without ever showing an unstyled one. With the fonts held for 3 s, first content came at 52 to 287 ms in the fallback faces and nothing moved when the files arrived, because a face that has not arrived by the first paint is not used for that load.

All 12 mid-page reloads in each engine started at the saved offset on the first frame with content, and so did the 12 over gzip in WebKit. The rapid-reload attack (scroll to 57% of the page, wait 150 ms, reload, twelve times) lost the position 0 times in 12 reloads at each width in both engines (48 in all). In the hydration attack (the heading changed before hydration, with the scripts delayed 3 s) the heading ended as the server wrote it and the document was never hidden or gated in any of the seven one-second samples, at both widths in both engines.

With JavaScript disabled in the browser (not by removing the script elements), the quickstart renders its heading, its sidebar links, its table of contents and highlighted code in the correct theme for both preferences in both engines, and a reload 600 ms after a scroll returns to the offset in 8 of 8 cases (see "Scroll restoration" for the shorter delays).

## Defects the measurement found

Each was reproduced, fixed at its cause and re-measured. The rows marked "round 4" came from an independent verifier's run on the previous commit (168 scenarios, of which 13 of the 24 without page scripts failed, and 34 raw assertions failed in its interaction run).

| Observation                                                                                                                                                                            | Cause                                                                                                                                                                          | Fix and result                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Round 4: with scripts removed, 12 of 12 WebKit scenarios moved boxes by up to 22 px, because the font gate that held the page was a script.                                            | An engine decodes a font face only after it has laid out the first text, and the gate that covered this needed JavaScript.                                                     | The gate and the embedded `data:` fonts are gone. The fonts are hashed files with a preload link in the head and `font-display: optional`, so the request starts before the body is parsed and a face that is late is skipped for that load. 0 of 24 `no-page-js` scenarios and 0 of 24 `font-delay` scenarios fail. |
| Round 4: with JavaScript disabled, a reload of a page scrolled halfway returned to the top in both engines (1551 to 0 at 1440 px, 1839 to 0 at 390 px).                                | The panel inside the page scrolled, so the browser's own scroll restoration had nothing to restore, and a script owned the offset.                                             | The document is the scroll container. The inset panel is a frame layer, and the sidebar and contents rail are sticky. Chromium restores at any delay; WebKit restores when the reload is at least 400 ms after the scroll (see "Scroll restoration").                                                                |
| In the build before the scroll-restore script was restored, 12 of 12 WebKit mid-page reloads showed the first frame at the top or at a stale offset, with the page scripts on.         | WebKit restores its own offset after the page's scripts have loaded, and from the entry it saved some time after the last scroll, so it overrode any restoration made earlier. | One inline script at the end of the body takes over restoration (see "Scroll restoration"). 12 of 12 mid-page reloads are at the offset on the first frame in each engine, over gzip too.                                                                                                                            |
| Round 4: the menus did not move focus into themselves on ArrowDown and lost it to `BODY` on Escape or after a choice; the drawer neither took focus nor made the page behind it inert. | Hand-written menu and drawer code.                                                                                                                                             | Radix dropdown menus for Appearance and the section switcher, Radix focus scope for the drawer, `inert` on the page behind it. Both menus wrap from the last item to the first (Radix `loop`), which the earlier checks did not cover; a test now does.                                                              |
| Round 4: choosing the current page in the drawer left it open.                                                                                                                         | The closing effect depended on a change of path.                                                                                                                               | Any link chosen in the drawer closes it, and so does widening the window. 8 of 8 checks pass.                                                                                                                                                                                                                        |
| Round 4: a `search-sections.json` holding `null` crashed the whole shell.                                                                                                              | The map was read without checking its shape.                                                                                                                                   | The shape is checked and a bad file leaves search working without sections. Zod's fast path compiles with `new Function`, which the policy (no `'unsafe-eval'`) blocks, so `z.config({ jitless: true })` is set; a unit test fails without it. 0 policy violations in 136 checks.                                    |
| The search palette's input took focus through `autoFocus`, which ran before the drawer's focus scope and lost the drawer's trap.                                                       | Order of focus handling.                                                                                                                                                       | The input takes focus through a ref in an effect. The drawer edge check passes.                                                                                                                                                                                                                                      |

## Scroll restoration

The document scrolls, not a panel inside it. With scripts off the browser restores a reloaded page by itself. With scripts on, a 444-byte inline script at the end of the body, before the `end-of-page` marker that holds the first paint in Chromium, sets `history.scrollRestoration` to `manual`, saves `scrollY` under `akter:scroll:<path>` in `sessionStorage` on `pagehide`, and scrolls to it only when the navigation entry is a reload or a back or forward visit, so a stale value cannot move a plain visit or a link to an anchor. It cannot run in the head, because the document has no height there yet.

With JavaScript disabled in the browser, a page scrolled to its middle and reloaded after a delay:

| Engine   | 0 ms | 150 ms | 500 ms | 1000 ms |
| -------- | ---- | ------ | ------ | ------- |
| Chromium | 4/4  | 4/4    | 4/4    | 4/4     |
| WebKit   | 0/4  | 0/4    | 4/4    | 4/4     |

(four pages and viewports per cell: `/quickstart` and `/api/01-server-api` at 1440 and 390 px). WebKit saves a page's offset in its history entry some time after the last scroll, so a reader who reloads within about 400 ms of scrolling, with scripts off, lands at the top. Nothing in the page can change that without a script, and the 8 failing cases are the known exception recorded under "Not verified"; the attack run, which waits 600 ms, passes 8 of 8.

## Fonts

Inter (latin subset, 98,880 bytes) and Geist Mono (latin subset, 10,544 bytes) are committed in `docs/fonts/` with their SIL Open Font Licence texts. `next/font/local` copies each into the export as `/_next/static/media/<name>.<hash>.woff2` and writes a `@font-face` rule for each, with `font-family` `Inter` and `Geist Mono` exactly as Capy's computed families read, `font-weight: 100 900` and `font-display: optional`, into the render-blocking stylesheet. Every page, including `404.html` and `_not-found.html`, carries two preload links (`as="font"`, `type="font/woff2"`, `crossorigin`). The stylesheet also declares `Inter Fallback` and `Geist Mono Fallback` from Arial with `size-adjust` of 107.4% and 131.49% and ascent and descent overrides.

Checked on the final export: 39 pages plus `404.html`, `_not-found.html` and `index.html` each have exactly two font preloads; no `.html`, `.css`, `.js`, `.json` or `.txt` file holds a `data:` font URL; the `_headers` policy has `font-src 'self'` and `img-src 'self'` with no `data:`; no file names PolySans; and `/_next/static/*` caches for a year as immutable. The files are served from the same origin, so there is no third-party font request. The build fails if any of these stops being true.

## Export size

39 pages, 39 Markdown twins and 39 sitemap entries. Gzipped at level 9, an HTML page is 12,967 bytes on average (66,930 bytes raw), 11,698 bytes at the median, 8,904 bytes at the smallest (`api/generated-contracts`) and 24,364 bytes at the largest (`operations/05-releasing`). Welcome is 10,962 bytes and Quickstart 20,593 bytes (161,973 raw). The one stylesheet is 30,127 bytes (6,369 gzipped) and the scripts total 303.9 KB gzipped. An earlier design that embedded the fonts as `data:` URLs in the stylesheet and in every page's head raised the mean page from 12.9 KB to 124.2 KB.

## Keyboard and behaviour

The interaction run is 68 checks in each engine and 136 in all, with 0 failing. In both engines at 1440 and 390 px: the Appearance menu offers Light, Dark and System, ArrowDown enters it, a choice gives focus back to the Appearance button, System removes the stored override, and the arrows rove and wrap; the section switcher opens onto an item, ArrowDown moves on, Escape gives focus back to the switcher and a chosen section navigates; the search palette opens with ⌘K, Tab cycles All, Documentation and API reference, the arrow keys move the active option, Enter opens a result and Escape closes it; nine hostile queries (empty, whitespace, no result, 10,000 characters, 1 MB, Unicode, markup, SQL-like, numbers) leave the palette working and unscrolled; four broken-dependency cases (the sections file missing, stale, `null` and the search index missing) leave the page working; the drawer opens with focus inside and the page behind it inert and unscrollable, Escape closes it and returns focus to its button, any link chosen closes it, and widening the window closes it; nothing takes focus at load; the console held no error and no policy violation; and at 320 px no page scrolls sideways.

The drawer's Tab trap is Radix's focus scope, which handles Tab and Shift+Tab. A separate edge check focuses the last control in the open drawer, presses Tab and expects the first, then presses Shift+Tab and expects the last: it passes in both engines (32 controls, from "Akter docs" to "Akter on GitHub"). In the interaction run, plain Tab in the Playwright WebKit build moves focus to the page body, so that run presses Alt+Tab, which Radix's scope does not handle; it counts focus on the inert page behind the drawer as escaping (it never took focus) and does not count focus moving once to the page body, which happened once in 45 presses.

## Parity with docs.capy.ai

The reference was captured from docs.capy.ai in a signed-in browser (the Appearance and switcher menus, the search palette empty and with results, the drawer, hover and state rows; 32 screens, the computed style, rectangle and variables of every shell element, and the article elements) and re-read live by an independent reviewer, who listed 19 differences that were not content or brand (B1 to B19). Each is resolved, measured on the final export:

| ID  | Difference                                    | Now                                                                                                                                                                                  |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | Welcome cards in two columns, Capy's in three | Three 256 px columns with 8 px gaps in both.                                                                                                                                         |
| B2  | API overview frame, title, rail and cards     | Article x 340, width 720, grid 48 px padding, 72 px gap, 220 px rail, title at (340, 57), mobile title at (24, 76), standalone card with 20 px and 24 px margins, as Capy's.         |
| B3  | Search footer hints                           | Literal ↑ ↓ ↵ keycaps, 18.156, 18.156 and 19.906 px wide, with Tab 29.078 and Esc 28.516, as Capy's.                                                                                 |
| B4  | Contents rail 6 px too long at first          | The first thumb runs 0 to 20 px in both.                                                                                                                                             |
| B5  | Contents range and motion                     | The thumb is clipped to every heading in view and moves with `clip-path 0.2s cubic-bezier(.23, 1, .32, 1)`: four headings (64 to 180 px) on Capy's page, two (96 to 168 px) on ours. |
| B6  | Documentation switcher icon                   | Displacement 0.5 px (was 4 px).                                                                                                                                                      |
| B7  | API switcher icon                             | 0.25 px (was 1.25 px).                                                                                                                                                               |
| B8  | Mobile navigation glyph                       | 0.25 px (was 1.275 px).                                                                                                                                                              |
| B9  | Copy glyph                                    | 0.25 px.                                                                                                                                                                             |
| B10 | Heading anchor glyph                          | 0.5 px (was 2.462 px).                                                                                                                                                               |
| B11 | Switcher grabber                              | 0.25 px.                                                                                                                                                                             |
| B12 | Search glyph                                  | 0.25 px.                                                                                                                                                                             |
| B13 | External-link arrow                           | 0 px (was 1.458 px).                                                                                                                                                                 |
| B14 | Welcome rocket                                | 0.75 px (was 1.414 px).                                                                                                                                                              |
| B15 | Quickstart bolt                               | 0.354 px (was 1.768 px).                                                                                                                                                             |
| B16 | Appearance sun                                | 0.25 px.                                                                                                                                                                             |
| B17 | Appearance system glyph                       | 0.25 px (was 1.601 px).                                                                                                                                                              |
| B18 | Selected checkmark                            | 0 px (was 1.275 px).                                                                                                                                                                 |
| B19 | X glyph                                       | 0.25 px.                                                                                                                                                                             |

The displacement is the largest distance from an ink pixel of one glyph to the nearest ink pixel of the other, both rendered at 4 times on the same origin; the moon, which the reviewer did not list, is 0.707 px. The ink bounds of Akter's and Capy's glyphs are equal to within 0.5 px in every case and no glyph is missing. Capy draws its icons from Central Icons, whose licence forbids shipping them where an end user can extract them, so these are redrawn from circles, rounded rectangles and lines (`apps/docs/src/components/glyphs.tsx`) and fitted to the rendered icons, which is why 0.75 px at most remains.

The frame behind the article matches too: its rectangle is equal at 1440 px in both schemes, the edge profile differs by at most 0.316 px (dark; 0 px in light) and the four corners differ in 0 pixels, and the contents rail's sticky top is 57 px at 1440 px (56.5 px on a 2 dppx display) with the sidebar's at 0.

What still differs, and why it stays:

| Difference                                                                                                                                                                                                      | Why it stays                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Capy's logo image, `Open Capy` and the Discord icon have no counterpart; ours are the Akter wordmark (65.8 px wide against the image's 66 px), `Open Akter` and the GitHub icon.                                | Brand. Discord is excluded by decision, and GitHub replaces it.                                                                                                                                                                                                                |
| The welcome page's screenshot, source grid and spotlight rows.                                                                                                                                                  | Capy product content; Akter has no screenshot or sources.                                                                                                                                                                                                                      |
| Sidebar group heights (173 px against 144 px), the active row's position, the hero title's width, table column widths, the code label's width (`Terminal` against a short language name), the contents entries. | The pages hold different text and a different number of rows and headings. Heights and widths follow the content; the styles that produce them match.                                                                                                                          |
| Search results: the method badge of an HTTP endpoint (a 38 × 18 px label against our 16 px icon), and the length of the list.                                                                                   | Capy's reference documents HTTP endpoints and ours documents TypeScript. Row heights (51.5 px), offsets, fonts and colours match.                                                                                                                                              |
| The Appearance menu's colour-theme submenu, the Discord link and the product screenshots.                                                                                                                       | Capy-only features with no Akter counterpart, left out by decision.                                                                                                                                                                                                            |
| Every text and surface colour differs.                                                                                                                                                                          | By decision: Capy's neutrals become Akter's tokens (text #ecebe7 dark and #0b0d0b light, panel #121311 and #fbfbfa), Capy's primary (links, ring, selection) becomes Akter yellow (#ffc300 dark, #8a6400 for text on light), and Capy's blue for information callouts is kept. |

## Other checks

- Static gates on the final tree: `bun run lint` (oxlint with type information, deny warnings), `bun run typecheck`, `bun tooling/structure/src/index.ts`, `bun run lint:directives` and the format check all exit 0; the docs app's tests are 22 files and 126 tests, including the components rendered in jsdom (menus, drawer, shell) and the unit tests for the scroll-restore script, the search sections shape check, the font delivery checks and the drawer's focus rules.
- An unknown address returns the on-theme 404 page with status 404; the file address `/404` answers 200 because it is the page file itself.
- Two builds of one commit, the second on a fully loaded machine, are byte for byte equal (`bun run check:reproducible`, run in a copy of the tree so that a running dev server's `.next` directory was left alone).
- A dead link or a missing anchor in a published page fails the build, and so does an export that names PolySans, lacks either font preload, names a font file the export does not hold, or carries a `data:` font URL.

## Not verified

- Safari itself and Firefox. WebKit was measured through Playwright's build, which is not Safari; Firefox was not run, and neither engine's paint timing was observed on a phone. Playwright has no CPU-throttle control for WebKit, so the WebKit `cpu4` rows repeat the plain load.
- A reload within about 400 ms of a scroll, with JavaScript disabled, in WebKit: it returns to the top (8 of 8 such reloads in this run, at 0 and 150 ms). WebKit decides when it saves the offset, no script runs to take over, and the page cannot change it. This is the recorded exception; every other condition restores the offset.
- The Cloudflare edge itself. The export was served by a local server that emulates `_redirects`, extensionless URLs, `_headers` and gzip. The policy was exercised in both engines, but the edge, its header handling and its cache were not.
- Real networks and an operating-system-cold font cache. The first paint does not wait for a font: a face that has not arrived by then is skipped for that load, so a reader on a slow connection reads the first page in the fallback faces, with identical metrics, and the files are cached for the next.
- The desktop contents list marks the active heading after hydration (a colour change and a marker, with transitions off). It is scroll-position state and is not part of first paint.
- The parity comparison is a measurement of computed styles and rectangles plus rendered glyph overlays, not a pixel diff of identical content: the two sites hold different pages. The reference screens were captured once; Capy can change them.
- Windows and Linux text rendering, the sign-in, GitHub and X links (they were read, not opened), search quality, and the cutover itself.

## Appendix: measurement harness

The two scripts that carry the first-paint claims are reproduced below; the export was served with the first and measured with the second, both run through the Mac's heavy-work gate. `matrix.mjs <base URL>` takes `ENGINES`, `MODES` and `LABEL` to select a part. The interaction, drawer edge, JavaScript-disabled, parity, glyph and export-size scripts are not reproduced here: they read the page the same way through Playwright, their results are the numbers above, and none is committed. `parity.mjs` and `glyphs.mjs` also read docs.capy.ai live.

### `server.mjs <export directory> <port> [gzip]`

```js
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
const root = path.resolve(process.argv[2])
const port = Number(process.argv[3])
const gzip = process.argv[4] === "gzip"
function config() {
  const redirects = fs
    .readFileSync(path.join(root, "_redirects"), "utf8")
    .trim()
    .split("\n")
    .map((l) => l.split(/\s+/))
  const rules = []
  for (const line of fs.readFileSync(path.join(root, "_headers"), "utf8").split("\n")) {
    if (line.startsWith("/")) rules.push({ pattern: line, headers: {} })
    else if (/^\s+\S/.test(line)) {
      const i = line.indexOf(":")
      rules.at(-1).headers[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
  }
  return { redirects, rules }
}
const pattern = (p) =>
  new RegExp(
    "^" +
      p
        .split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("(.*)") +
      "$",
  )
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".xml": "application/xml",
  ".woff2": "font/woff2",
}
const compressible = new Set([".html", ".css", ".js", ".json", ".txt", ".md", ".svg", ".xml"])
const requests = []
const server = http.createServer((req, res) => {
  if (req.url === "/__requests") {
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(requests.splice(0)))
    return
  }
  if (!fs.existsSync(path.join(root, "_headers"))) {
    res.writeHead(503)
    res.end("Build not ready")
    return
  }
  const { redirects, rules } = config()
  const url = new URL(req.url, "http://localhost")
  const pathname = decodeURIComponent(url.pathname)
  for (const r of rules)
    if (pattern(r.pattern).test(pathname))
      for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v)
  for (const [from, to, status] of redirects) {
    const m = pathname.match(pattern(from))
    if (m) {
      res.writeHead(Number(status), { Location: to.replace(":splat", m[1] ?? "") })
      res.end()
      return
    }
  }
  let filename = path.join(root, pathname === "/" ? "index.html" : pathname)
  if (!filename.startsWith(root + "/")) {
    res.writeHead(400)
    res.end()
    return
  }
  if (fs.existsSync(filename + ".html")) filename += ".html"
  if (!fs.existsSync(filename) || fs.statSync(filename).isDirectory()) {
    filename = path.join(root, "404.html")
    res.statusCode = 404
  }
  const ext = path.extname(filename)
  if (!res.hasHeader("Content-Type"))
    res.setHeader("Content-Type", types[ext] ?? "application/octet-stream")
  let body = fs.readFileSync(filename)
  if (gzip && compressible.has(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
    body = zlib.gzipSync(body)
    res.setHeader("Content-Encoding", "gzip")
    res.setHeader("Vary", "Accept-Encoding")
  }
  requests.push({
    pathname,
    status: res.statusCode,
    type: res.getHeader("Content-Type"),
    bytes: body.length,
    encoding: res.getHeader("Content-Encoding") ?? null,
    cache: res.getHeader("Cache-Control") ?? null,
  })
  res.setHeader("Content-Length", body.length)
  res.end(body)
})
server.listen(port, "127.0.0.1", () =>
  console.log(JSON.stringify({ pid: process.pid, cwd: process.cwd(), root, port, gzip })),
)
```

### `matrix.mjs`

```js
import { createRequire } from "node:module"
import fs from "node:fs"
const require = createRequire(
  "/Users/dallenpyrah/Projects/rika-labs/akter-cloud/node_modules/.bun/playwright@1.63.0/node_modules/playwright/package.json",
)
const pw = require("playwright")
const base = process.argv[2]
const out = "/Users/dallenpyrah/.capy/work/akter-docs-takeover"
const label = process.env.LABEL ?? "matrix"
const engines = (process.env.ENGINES ?? "webkit,chromium").split(",")
const modes = (process.env.MODES ?? "cold,warm,mid,opposite,no-page-js,css-delay,cpu4").split(",")
const results = []
function recorder() {
  window.__measure = { frames: [], shifts: [], paints: [], violations: [] }
  document.addEventListener("securitypolicyviolation", (e) =>
    window.__measure.violations.push([e.violatedDirective, e.blockedURI]),
  )
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        window.__measure.shifts.push({
          value: e.value,
          recent: e.hadRecentInput,
          time: e.startTime,
        })
    }).observe({ type: "layout-shift", buffered: true })
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        window.__measure.paints.push({ name: e.name, time: e.startTime })
    }).observe({ type: "paint", buffered: true })
  } catch {}
  const tick = (t) => {
    const root = document.documentElement,
      main = document.getElementById("ak-main")
    const rects = {}
    let n = 0
    for (const el of document.querySelectorAll(
      "h1,h2,h3,h4,p,li,a,button,header,nav,aside,main,footer,img,pre,table,svg,kbd,input",
    )) {
      const st = getComputedStyle(el),
        r = el.getBoundingClientRect(),
        id =
          el.tagName +
          "|" +
          n++ +
          "|" +
          (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 55)
      if (!r.width || !r.height || st.visibility === "hidden" || st.display === "none") continue
      let opacity = 1
      for (let p = el; p; p = p.parentElement) opacity *= Number(getComputedStyle(p).opacity)
      let fixed = false
      for (let q = el; q && q !== document.documentElement; q = q.parentElement) {
        const ps = getComputedStyle(q).position
        if (ps === "fixed" || ps === "sticky") {
          fixed = true
          break
        }
      }
      const offset = fixed ? 0 : scrollY
      rects[id] = [
        r.x,
        r.y + offset,
        r.width,
        r.height,
        opacity,
        r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
      ]
    }
    window.__measure.frames.push({
      t,
      rects,
      scroll: scrollY,
      pageY: 0,
      bg: root ? getComputedStyle(root).backgroundColor : null,
      panel: main ? getComputedStyle(main).backgroundColor : null,
      fonts: [...document.fonts].map((f) => [f.family, f.status]),
      h1: !!document.querySelector("h1"),
      gate: root?.hasAttribute("data-font-gate"),
      cls: root?.className,
    })
    if (!window.__stopMeasure) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
function analyze(m, target) {
  const paint = m.paints.find((p) => p.name === "first-paint")?.time
  const frames = m.frames.filter(
    (f) => f.h1 && Object.keys(f.rects).length > 10 && (paint === undefined || f.t >= paint),
  )
  if (!frames.length) return { error: "no visible content frames", frameCount: m.frames.length }
  const first = frames[0],
    last = frames.at(-1),
    moving = new Map(),
    fades = new Map(),
    late = []
  for (const f of frames)
    for (const [k, r] of Object.entries(f.rects)) {
      const settled = last.rects[k]
      if (!settled) continue
      const d = Math.max(...r.slice(0, 4).map((v, i) => Math.abs(v - settled[i])))
      if (d > 0.5) moving.set(k, Math.max(moving.get(k) || 0, d))
      if (Math.abs(r[4] - settled[4]) > 0.01) fades.set(k, [r[4], settled[4]])
    }
  for (const [k, r] of Object.entries(last.rects)) if (!first.rects[k] && r[5]) late.push(k)
  const scroll = [...new Set(frames.map((f) => Math.round(f.scroll)))]
  return {
    frameCount: m.frames.length,
    contentFrames: frames.length,
    paints: m.paints,
    firstMs: first.t,
    firstFonts: first.fonts,
    movers: [...moving],
    fades: [...fades],
    late,
    scroll,
    target,
    scrollWrong: scroll.some((v) => Math.abs(v - target) > 1),
    pageY: [...new Set(frames.map((f) => f.pageY))],
    bg: [...new Set(frames.map((f) => f.bg))],
    panel: [...new Set(frames.map((f) => f.panel))],
    cls: m.shifts.reduce((s, e) => s + (e.recent ? 0 : e.value), 0),
    shifts: m.shifts,
    violations: m.violations,
  }
}
for (const engine of engines) {
  const browser = await pw[engine].launch(engine === "chromium" ? { channel: "chrome" } : {})
  try {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ])
      for (const scheme of ["dark", "light"])
        for (const pathname of ["/welcome", "/quickstart", "/api/01-server-api"])
          for (const mode of modes) {
            const ctx = await browser.newContext({
              viewport: { width, height },
              colorScheme: scheme,
            })
            const page = await ctx.newPage()
            const errors = []
            page.on("pageerror", (e) => errors.push(e.message))
            page.on("console", (m) => {
              if (m.type() === "error") errors.push(m.text())
            })
            if (mode === "cpu4" && engine === "chromium") {
              const session = await ctx.newCDPSession(page)
              await session.send("Emulation.setCPUThrottlingRate", { rate: 4 })
            }
            if (mode === "opposite")
              await ctx.addInitScript(
                (v) => localStorage.setItem("akter-theme", v),
                scheme === "dark" ? "light" : "dark",
              )
            let target = 0
            if (mode === "warm" || mode === "mid") {
              await page.goto(base + pathname, { waitUntil: "networkidle" })
              if (mode === "mid") {
                target = await page.evaluate(() => {
                  const e = document.documentElement
                  window.scrollTo(0, Math.floor((e.scrollHeight - e.clientHeight) / 2))
                  return Math.round(window.scrollY)
                })
                await page.waitForTimeout(200)
              }
            }
            await ctx.addInitScript(recorder)
            if (mode === "no-page-js") {
              await ctx.route("**/*", async (route) => {
                if (route.request().resourceType() === "document") {
                  const response = await route.fetch()
                  const html = (await response.text()).replace(
                    /<script\b[^>]*>[\s\S]*?<\/script>/gi,
                    "",
                  )
                  await route.fulfill({ response, body: html })
                } else await route.continue()
              })
            }
            if (mode === "css-delay")
              await ctx.route("**/*.css", async (route) => {
                await new Promise((r) => setTimeout(r, 2200))
                await route.continue()
              })
            if (mode === "font-delay")
              await ctx.route("**/*.woff2", async (route) => {
                await new Promise((r) => setTimeout(r, 3000))
                await route.continue()
              })
            if (mode === "warm" || mode === "mid") await page.reload({ waitUntil: "load" })
            else await page.goto(base + pathname, { waitUntil: "load" })
            await page.waitForTimeout(2400)
            const m = await page.evaluate(() => {
              window.__stopMeasure = true
              return window.__measure
            })
            const fontUsed = await page.evaluate(() => {
              const width = (family, size, text) => {
                const s = document.createElement("span")
                s.style.cssText =
                  "position:absolute;left:-9999px;top:0;white-space:nowrap;font:500 " +
                  size +
                  "px " +
                  family
                s.textContent = text
                document.body.append(s)
                const w = s.getBoundingClientRect().width
                s.remove()
                return w
              }
              const sans = "iiiiiiiiiiWWWWWWWWWWmmmmmmmmmmlllllll",
                mono = "iiiiiiiiiiWWWWWWWWWW"
              return {
                sans:
                  Math.abs(
                    width("var(--font-sans)", 26, sans) - width('"Inter Fallback"', 26, sans),
                  ) > 1,
                mono:
                  Math.abs(
                    width("var(--font-mono)", 26, mono) - width('"Geist Mono Fallback"', 26, mono),
                  ) > 1,
              }
            })
            const result = {
              engine,
              width,
              height,
              scheme,
              pathname,
              mode,
              cpuThrottled: mode === "cpu4" && engine === "chromium",
              errors,
              fontUsed,
              gateSeen: m.frames.some((f) => f.gate),
              ...analyze(m, target),
            }
            result.failed = !!(
              result.error ||
              result.movers?.length ||
              result.fades?.length ||
              result.late?.length ||
              result.scrollWrong ||
              result.cls ||
              result.bg?.length > 1 ||
              result.panel?.length > 1 ||
              result.pageY?.some((v) => v !== 0) ||
              result.violations?.length ||
              result.gateSeen ||
              errors.length
            )
            results.push(result)
            fs.writeFileSync(out + "/" + label + ".json", JSON.stringify(results, null, 2))
            console.log(
              JSON.stringify({
                engine,
                width,
                scheme,
                pathname,
                mode,
                failed: result.failed,
                movers: result.movers?.slice(0, 4),
                scroll: result.scroll,
                target,
                cls: result.cls,
                fontUsed,
                errors: errors.slice(0, 2),
              }),
            )
            if (["cold", "no-page-js"].includes(mode) && pathname === "/quickstart")
              await page.screenshot({
                path: `${out}/shots/${label}-${engine}-${width}-${scheme}-${mode}.png`,
              })
            await ctx.close()
          }
  } finally {
    await browser.close()
  }
}
console.log(
  "SUMMARY",
  results.length,
  "scenarios",
  results.filter((r) => r.failed).length,
  "failed",
  "fallback-font",
  results.filter((r) => !r.fontUsed.sans || !r.fontUsed.mono).length,
)
```
