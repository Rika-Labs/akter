# Docs appearance and first-paint evidence

**Responsibility:** bound the public documentation's first-paint, theme, navigation, font-loading and reference-match claims.

**Authority:** evidence.

**Owner role:** documentation.

**Change policy:** rerun the measurement matrix below when `apps/docs` layout, its stylesheet, the Fumadocs version or the fonts change, and rerun the parity comparison when the reference site changes.

## Claims

The public docs are the static export of `apps/docs`. The page the browser receives is complete: every element a reader sees on first paint is in the server-rendered HTML.

1. The theme follows `prefers-color-scheme` until the reader picks Light or Dark in the Appearance menu, and a pick is applied before the first paint. No frame shows the other theme, and the page and panel backgrounds each take one value during a load.
2. After the first paint no element moves by more than 0.5 px, changes size, or fades, on a load or a refresh, including a refresh that restores a mid-page scroll position of the panel, and including loads where the page scripts are slow or never arrive.
3. A late font never swaps in. Inter and Geist Mono are embedded in the stylesheet, so there is no request to wait for, and the page is held hidden until both are decoded; if either fails or takes longer than 1.5 s the page shows in the fallback face for that load.
4. Nothing animates in on load: no entrance transition, no hydration-time swap of visible text.
5. The shell matches docs.capy.ai measurement for measurement in Akter's colours; every remaining difference is Capy's own content or brand, or an implementation detail that cannot be seen.

## Environment and method

Collected on 2026-10-18 on macOS 26.6.2 (arm64), Google Chrome 155.0.8059.80 and Playwright's WebKit 26.6, both driven by Playwright 1.63.0, Bun 1.4.2, Node 26.7.0, Next.js 16.4.2 and fumadocs-ui 16.17.5. The export was served by a small static server that applies `_redirects` and `_headers`, so the policy was in force for the measurements.

The no-shift harness (the appendix) records every animation frame from document start until 3.5 s after the reload. In each frame it reads the rectangle and the effective opacity of every `h1`, `h2`, `h3`, `p`, `li`, `a`, `button`, `header`, `nav`, `aside`, `main`, `footer`, `iframe`, `img`, `pre`, `table`, `svg` and `kbd`, keyed by tag and visible text and measured in the coordinates of the scroll container the element lives in (the panel scrolls, not the window), and skips elements that are `visibility: hidden`. It also records the `html`, `body` and panel backgrounds, the panel's scroll offset, the window's scroll offset, which fonts are loaded, the paint timing entries and `layout-shift` entries. A scenario passes only if all of the following hold from the first painted frame on (the first frame at or after the first-paint entry, or the first frame with content where an engine reports none): no element differs from its settled rectangle by more than 0.5 px, none changes opacity, none appears inside the viewport later, the layout-shift total is 0, each background takes one value, the window never scrolls, and the panel's offset takes one value, equal to the offset before the reload on a mid-page reload.

The matrix is the product of: pages `/welcome`, `/quickstart` and `/api/01-server-api`; viewports 1440 × 900 and 390 × 844; schemes dark and light; scroll top, and the panel scrolled to the middle then reloaded so the page restores the offset; and three script conditions on the reload: scripts as served, every script file answered after 1.5 s, and every script file blocked. The last two put the main thread at rest, which is when a browser paints earliest. Two attacks run beside it: a reload 150 ms after a scroll, repeated 12 times per viewport, and a forced hydration mismatch (the heading changed before hydration, with scripts delayed 3 s) that must end on the server's text with the page never hidden after the gate lifts.

## Results

| Build                                      | Scenarios | Failing | Frames recorded | Moved or resized elements | Fades | Late in viewport | Layout shift |
| ------------------------------------------ | --------- | ------- | --------------- | ------------------------- | ----- | ---------------- | ------------ |
| Static export, Chromium                    | 72        | 0       | 15,169          | 0                         | 0     | 0                | 0            |
| Static export, WebKit                      | 72        | 0       | 15,080          | 0                         | 0     | 0                | 0            |
| Same export before the font gate, Chromium | 72        | 3       | 15,184          | 50                        | 0     | 0                | 0.0024       |
| Same export before the font gate, WebKit   | 72        | 32      | 15,097          | 820                       | 0     | 0                | 0            |

At 1440 px wide the page is the darker surface and the panel sits on it: dark scenarios saw only `rgb(10, 10, 9)` behind the panel and `rgb(18, 19, 17)` in it, and light scenarios only `rgb(238, 238, 237)` and `rgb(251, 251, 250)`. At 390 px wide the page is the panel: dark scenarios saw only `rgb(18, 19, 17)` on the page and a transparent panel, and light scenarios only `rgb(251, 251, 250)`. Each scenario saw one value of each, and none saw white in dark. First content appeared at most 43 ms after navigation start in Chromium and between 14 and 77 ms in WebKit. All 36 reloads of a scrolled panel in each engine were at the saved offset on the first frame with content. The rapid-reload attack lost the position 0 times in 24 reloads per engine (12 at each width), and in the hydration attack the heading ended as the server wrote it and the page was hidden in none of the 14 one-second samples, at both widths in both engines.

The two rows "before the font gate" are the same export without the gate, measured with the harness in the appendix. Every failure was in a condition where the page scripts were slow or blocked; the 24 scenarios with scripts as served passed in both engines. In Chromium 3 of the 48 failed: two moved boxes, and one recorded a layout shift with no box moving. Counted from the first frame with content, an earlier variant of the harness, 15 of the 48 failed with 460 moved boxes. WebKit reports no paint entry, so both variants start at the first frame with content and agree: 32 of 48. The recorded movements were 0.9 to 22.4 px, in text and in everything below it, while a font face was still decoding.

With JavaScript disabled, the quickstart renders its heading, 25 sidebar links, its table of contents and highlighted code in the correct theme for both preferences in both engines, so the first paint does not depend on a script.

## Defects the measurement found

Each was reproduced, fixed at its cause and re-measured; the matrix above is the run after the last fix.

| Observation                                                                                                                                                                                                                                                                                                            | Cause                                                                                                                                                                                                                                                                                                            | Fix and result                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| With the page scripts slow or blocked, boxes moved by up to 22 px after the first paint: 3 of 48 scenarios in Chromium (15 of 48 counted from the first frame with content) and 32 of 48 in WebKit. Layout-shift entries stayed 0 because the movement happens before the first frame the browser counts.              | An engine decodes an embedded font face only after it has laid out the first text. With nothing else running, the first paint came before the decode, so boxes were laid out for the fallback face and moved when Inter arrived. With the scripts as served the main thread was busy and the decode usually won. | `html` is gated while the page loads: a head script sets `data-font-gate` and a style hides the page until a script before the end marker finds Inter and Geist Mono decoded (or loading fails, or 1.5 s pass). 0 of 144 scenarios fail in the two engines afterwards.                                                                          |
| The first version of the gate left the page hidden after a forced hydration mismatch: the attribute was still on `html` at the end of the attack, in both engines and at both widths.                                                                                                                                  | The attribute was part of the markup React renders. When something changes the page before it hydrates, React discards the server markup and renders the page again, which puts the attribute back after the script has removed it.                                                                              | The attribute is set by a head script and never rendered; a unit test fails if the layout names it. The attack ends on the server's heading with the page visible, in both engines at both widths.                                                                                                                                              |
| A reload that restored a scroll offset showed the first frame at the wrong offset, or at the top, and corrected itself later (Chrome's scroll anchoring during history restoration; WebKit restoring its own offset only after the page scripts have loaded). Found on the previous layout, where the window scrolled. | Scroll anchoring on the restored position in Chrome, and WebKit's late restoration.                                                                                                                                                                                                                              | `overflow-anchor: none` everywhere, `history.scrollRestoration` set to manual, and one inline script that restores the saved offset of the panel from `sessionStorage` before the first paint on a reload or a back or forward load. 0 of 24 rapid reloads lost the position in each engine, and 36 of 36 mid-page reloads start at the offset. |
| Chrome could paint a half-parsed document.                                                                                                                                                                                                                                                                             | The parser had not reached the end of the body when the first frame was due.                                                                                                                                                                                                                                     | A render-blocking `<link rel="expect" href="#end-of-page" blocking="render">` holds the first paint until the end marker is parsed. WebKit does not honour it, which the gate covers.                                                                                                                                                           |

## Fonts

Inter (latin subset, 98.9 kB) and Geist Mono (latin subset, 10.5 kB) are committed in `docs/fonts/` with their SIL Open Font Licence texts and embedded by `bun scripts/embed-fonts.ts` as `data:` URLs in the stylesheet, which is about 146 kB of text and travels once: it is hashed, cached for a year, and no request for a font follows it. The faces are `font-display: block`. The earlier choice, `optional`, was dropped during development because a face that misses the engine's short window stays on the fallback for the life of the page, and code then draws in a proportional face; that comparison is not part of the matrix here. With `block` the line `mkdir -p .local` in a code block measured 115.1 px wide in Chromium and 115 px in WebKit in 5 of 5 cold loads of the final export in each engine.

The stylesheet also declares `Inter Fallback` and `Geist Mono Fallback` from Arial with `size-adjust` of 107.4% and 131.49% and ascent and descent overrides. These values come from the published metrics of the faces and were not measured here; they apply only if an embedded face fails to decode, which the 1.5 s backstop turns into a visible page.

## Parity with docs.capy.ai

The reference was captured from docs.capy.ai on 2026-10-18 in a signed-in browser: 32 screens (1440 × 900 dark and light, 390 × 844 closed, drawer open and appearance menu open, the product switcher, the search palette empty and with results, sidebar hover and state rows, the appearance menu), with the computed style, rectangle and variables of every shell element and of the article elements. The same measurement ran on the export at the same sizes, and 30 side-by-side sheets with red difference overlays were made; two reference screens have no counterpart by decision (the colour-theme submenu and Capy's own welcome page). The numeric comparison covers the 11 captures that have a measured counterpart (welcome, environment and API reference at 1440 × 900, welcome and environment at 390 × 844 closed and with the drawer open, in the themes they were captured in) and the search results: 218 differences across 74 element and property pairs, grouped below. The other screens were compared on the sheets.

The first comparison found two differences that were ours: a result for a page or for a heading had no second line (40 px against Capy's 51.5 px), and a paragraph hit was titled with the page instead of its section. A fresh read of docs.capy.ai's search on four queries (`snapshots`, `thread`, `environment` and `machine`) gave 56 rows, every one 51.5 px high with a second line. Page rows now show the page's description and the group; heading and paragraph hits show their section's heading, the page and the heading above it, and the first paragraph or the matched text. The build writes those sections to `search-sections.json`, because the search index does not keep them. Every result row now measures 51.5 px and sits at Capy's offsets.

Style parity was also checked on the elements the five screens do not all contain, on the pages that have them: the third-level heading, a deep contents entry, the code label and copy button, a table, a callout, inline code, links and the code block all match Capy's computed values on `/api/01-server-api` and `/operations/self-host`.

| Difference                                                                                                                                                                                                                                                                                                                                                                                                | Why it stays                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Capy's logo image, `Open Capy` and the Discord icon have no counterpart; ours are the Akter wordmark (65.8 px wide against the image's 66 px), `Open Akter` and the GitHub icon.                                                                                                                                                                                                                          | Brand. Discord is excluded by decision, and GitHub replaces it.                                                                                                                                                                                                                |
| The welcome page's screenshot, source grid and spotlight rows.                                                                                                                                                                                                                                                                                                                                            | Capy product content; Akter has no screenshot or sources. Cards, headings and the hero text use the same styles.                                                                                                                                                               |
| Sidebar group heights (173 px against 144 px), the active row's position, the first card's width (388 px in a two-up row against 256 px in a three-up row), the hero title's width, table column widths, the code label's width (`Terminal` against a short language name), the API overview's layout (Akter's is a generated grid of cards on the landing layout, Capy's is prose with a contents list). | The pages hold different text and a different number of rows and headings. Heights and widths follow the content; the styles that produce them match.                                                                                                                          |
| The active contents entry is `position: relative` in ours and static in Capy's.                                                                                                                                                                                                                                                                                                                           | The rail is drawn with pseudo-elements on the entry. The result looks the same.                                                                                                                                                                                                |
| Search results: the method badge of an HTTP endpoint (a 38 × 18 px label against our 16 px icon), the length of the list, and the row at which the first icon sits.                                                                                                                                                                                                                                       | Capy's reference documents HTTP endpoints and ours documents TypeScript, so there are no badges. Row heights, offsets, fonts and colours match.                                                                                                                                |
| Every text and surface colour differs.                                                                                                                                                                                                                                                                                                                                                                    | By decision: Capy's neutrals become Akter's tokens (text #ecebe7 dark and #0b0d0b light, panel #121311 and #fbfbfa), Capy's primary (links, ring, selection) becomes Akter yellow (#ffc300 dark, #8a6400 for text on light), and Capy's blue for information callouts is kept. |

## Other checks

- Keyboard and behaviour, 55 checks in Chromium and 52 in WebKit (the three clipboard checks run in Chromium only): the appearance menu offers exactly Light, Dark and System, keeps the choice across a reload, clears it on System and closes on Escape; the product switcher swaps the sidebar to the API tree and back and opens the overview; the search palette opens with ⌘K and from both buttons, lists suggestions, highlights matches, shows the page's description on every page result and gives every result row two lines, filters with Tab (All, Documentation, API reference, back to All), moves with the arrow keys, opens a result with Enter, shows an empty message, and closes on Escape and on a click outside; the 300 px drawer opens, closes on the scrim, on Escape and when a page is chosen; Copy page copies the page's Markdown, the code copy button copies the code, View as Markdown links the `.md` twin with the right type; a contents entry scrolls the panel and is the only one marked active; a reload keeps the panel's offset, a plain visit and a sidebar click start at the top, and a deep link scrolls the panel to its heading.
- The security policy (`font-src 'self' data:` among its directives) produced no violation on 8 pages at desktop and mobile widths with search, copy and page actions used, and both fonts loaded from the stylesheet with no font request.
- An unknown address returns the on-theme 404 page with status 404 (the hosting uses 404-page handling); the file address `/404` answers 200 because it is the page file itself. The export has 39 pages (37 Markdown pages from `docs/` and the generated welcome page and API overview), 39 Markdown twins and 39 sitemap entries, and a 36 kB `search-sections.json` beside the 847 kB search index.
- Two builds of one commit, the second on a fully loaded machine, are byte for byte equal.
- A dead link or a missing anchor in a published page fails the build, and so does an export that names PolySans or lacks either embedded font.

## Not verified

- Safari itself and Firefox. WebKit was measured through Playwright's build, which is not Safari; Firefox was not run, and neither engine's paint timing was observed on a phone.
- The Cloudflare edge itself. The export was served by a local server that emulates `_redirects`, extensionless URLs and `_headers`. The policy was exercised in Chromium, but the edge, its header handling and its cache were not.
- Real networks. The first paint waits for a stylesheet that carries the fonts and then for their decode; local runs show first content within 77 ms, but a slow connection waits longer for the fonts than a page with a fallback would, in return for never painting a face that will be replaced.
- The desktop contents list marks the active heading after hydration (a colour change and a marker, with transitions off). It is scroll-position state and is not part of first paint.
- The parity comparison is a measurement of computed styles and rectangles plus a visual read of the sheets, not a pixel diff of identical content: the two sites hold different pages. The reference screens were captured once; Capy can change them.
- Windows and Linux text rendering, the sign-in, GitHub and X links (they were read, not opened), search quality, and the cutover itself.

## Appendix: measurement harness

Run `ENGINE=<chromium or webkit> node matrix-r5.mjs <base URL> <label> <pages> <script modes>` with the export served at the base URL; results are written as JSON and a PASS or FAIL line per scenario is printed. `attacks-r5.mjs <base URL> <engine> <rapid or hydration> <iterations>` runs the two attacks.

```js
import { createRequire } from "node:module"
import { writeFileSync, mkdirSync } from "node:fs"
const require = createRequire(
  "/Users/dallenpyrah/Projects/rika-labs/akter-cloud/node_modules/.bun/playwright@1.63.0/node_modules/playwright/",
)
const pw = require("playwright")
const engine = process.env.ENGINE ?? "chromium"

const base = process.argv[2]
const label = process.argv[3]
const pages = (process.argv[4] ?? "/welcome,/quickstart,/api/01-server-api").split(",")
const scriptModes = (process.argv[5] ?? "normal,slow,blocked").split(",")
const out = "/Users/dallenpyrah/.capy/work/akter-docs-evidence/measure"
mkdirSync(out, { recursive: true })
const STOP_MS = 3500

const recorder =
  "(" +
  function (stopMs) {
    const frames = []
    window.__frames = frames
    window.__cls = 0
    window.__paints = []
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__paints.push([e.name, e.startTime])
      }).observe({ type: "paint", buffered: true })
    } catch {}
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value
      }).observe({ type: "layout-shift", buffered: true })
    } catch {}
    const selector =
      "h1,h2,h3,p,li,a,button,header,nav,aside,main,footer,iframe,img,pre,table,svg,kbd"
    const effectiveOpacity = (el) => {
      let o = 1
      for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity)
      return o
    }
    const snap = (ts) => {
      const root = document.documentElement
      const body = document.body
      const main = document.getElementById("ak-main")
      const rects = {}
      const counts = {}
      let visible = 0
      if (body) {
        for (const el of document.querySelectorAll(selector)) {
          const r = el.getBoundingClientRect()
          const text = (
            el.innerText ||
            el.getAttribute("aria-label") ||
            el.getAttribute("href") ||
            ""
          )
            .trim()
            .slice(0, 40)
          const key = el.tagName + "|" + text
          counts[key] = (counts[key] || 0) + 1
          if (r.width === 0 && r.height === 0) continue
          if (getComputedStyle(el).visibility === "hidden") continue
          visible++
          const offset = main && main.contains(el) ? main.scrollTop : window.scrollY
          rects[key + "#" + counts[key]] = [
            r.x + scrollX,
            r.y + offset,
            r.width,
            r.height,
            effectiveOpacity(el),
          ]
        }
      }
      frames.push({
        t: ts,
        scroll: main ? main.scrollTop : window.scrollY,
        pageScroll: window.scrollY,
        vh: window.innerHeight,
        bg: root ? getComputedStyle(root).backgroundColor : null,
        bodyBg: body ? getComputedStyle(body).backgroundColor : null,
        panelBg: main ? getComputedStyle(main).backgroundColor : null,
        visible,
        h1: !!(body && body.querySelector("h1")),
        loadedFonts: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
        rects,
      })
    }
    const loop = (ts) => {
      snap(ts)
      if (ts < stopMs) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  } +
  ")(" +
  STOP_MS +
  ")"

function analyse(frames, cls, paints) {
  const first = frames.findIndex((f) => f.h1 && Object.keys(f.rects).length > 10)
  if (first < 0) return { error: "no content frame", frames: frames.length }
  const settled = frames[frames.length - 1]
  const viewportBottom = (f) => f.scroll + f.vh
  const firstPaintEntry = paints.find((p) => p[0] === "first-paint")
  const firstPaintAt = firstPaintEntry ? firstPaintEntry[1] : null
  let painted = first
  if (firstPaintAt !== null) {
    const idx = frames.findIndex((f) => f.t >= firstPaintAt - 20)
    painted = Math.max(first, idx < 0 ? first : idx)
  }
  const strictMovers = []
  for (const key of Object.keys(frames[first].rects)) {
    let worst = 0
    for (const f of frames.slice(first)) {
      const r = f.rects[key]
      const st = settled.rects[key]
      if (!r || !st) continue
      worst = Math.max(
        worst,
        Math.abs(r[0] - st[0]),
        Math.abs(r[1] - st[1]),
        Math.abs(r[2] - st[2]),
        Math.abs(r[3] - st[3]),
      )
    }
    if (worst > 0.5) strictMovers.push(key)
  }
  const movers = []
  const fades = []
  for (const key of Object.keys(frames[painted].rects)) {
    let worst = 0
    let lo = 1
    let hi = 0
    for (const f of frames.slice(painted)) {
      const r = f.rects[key]
      const s = settled.rects[key]
      if (!r || !s) continue
      worst = Math.max(
        worst,
        Math.abs(r[0] - s[0]),
        Math.abs(r[1] - s[1]),
        Math.abs(r[2] - s[2]),
        Math.abs(r[3] - s[3]),
      )
      lo = Math.min(lo, r[4])
      hi = Math.max(hi, r[4])
    }
    if (worst > 0.5) movers.push([key, +worst.toFixed(2)])
    if (hi - lo > 0.01) fades.push([key, +lo.toFixed(2), +hi.toFixed(2)])
  }
  const late = []
  for (const key of Object.keys(settled.rects)) {
    if (frames[painted].rects[key]) continue
    const s = settled.rects[key]
    if (s[1] < viewportBottom(settled)) late.push(key)
  }
  const bgs = new Set()
  const panels = new Set()
  for (const f of frames) {
    bgs.add(f.bg)
    bgs.add(f.bodyBg)
    if (f.panelBg) panels.add(f.panelBg)
  }
  const afterFirst = frames.slice(painted)
  return {
    frames: frames.length,
    firstPaintMs: firstPaintAt === null ? null : Math.round(firstPaintAt),
    firstPaintFrame: painted,
    strictMoversFromFirstContentFrame: strictMovers.length,
    fontAtFirstPaint: frames[painted].loadedFonts.filter(
      (f) => f.includes("Inter") || f.includes("Geist"),
    ),
    firstContentFrame: first,
    firstContentMs: Math.round(frames[first].t),
    firstVisible: frames[first].visible,
    settledVisible: settled.visible,
    movers: movers.length,
    moversDetail: movers.slice(0, 5),
    fades: fades.length,
    fadesDetail: fades.slice(0, 5),
    lateInViewport: late.length,
    lateDetail: late.slice(0, 5),
    bgValues: [...bgs].filter(Boolean),
    panelValues: [...panels],
    scrollValues: [...new Set(afterFirst.map((f) => Math.round(f.scroll)))],
    pageScrollValues: [...new Set(afterFirst.map((f) => Math.round(f.pageScroll)))],
    cls: +cls.toFixed(4),
    fontAtFirstContent: frames[first].loadedFonts.filter(
      (f) => f.includes("Inter") || f.includes("Geist"),
    ),
    fontSettled: settled.loadedFonts.filter((f) => f.includes("Inter") || f.includes("Geist")),
  }
}

const browser = await pw[engine].launch(engine === "chromium" ? { channel: "chrome" } : {})
const results = []
for (const mode of scriptModes) {
  for (const [vp, w, h] of [
    ["desktop", 1440, 900],
    ["mobile", 390, 844],
  ]) {
    for (const scheme of ["dark", "light"]) {
      for (const path of pages) {
        for (const scroll of ["top", "mid"]) {
          const ctx = await browser.newContext({
            viewport: { width: w, height: h },
            colorScheme: scheme,
          })
          const page = await ctx.newPage()
          await page.goto(base + path, { waitUntil: "networkidle" })
          if (scroll === "mid") {
            await page.evaluate(() => {
              const m = document.getElementById("ak-main")
              m.scrollTop = Math.floor((m.scrollHeight - m.clientHeight) / 2)
            })
            await page.waitForTimeout(400)
          }
          const target = await page.evaluate(() =>
            Math.round(document.getElementById("ak-main").scrollTop),
          )
          await page.addInitScript(recorder)
          if (mode !== "normal") {
            await ctx.route("**/*.js", async (route) => {
              if (mode === "blocked") return route.abort()
              await new Promise((r) => setTimeout(r, 1500))
              return route.continue()
            })
          }
          await page.reload({ waitUntil: "load" })
          await page.waitForTimeout(STOP_MS + 400)
          const { frames, cls, paints } = await page.evaluate(() => ({
            frames: window.__frames,
            cls: window.__cls,
            paints: window.__paints,
          }))
          const result = {
            label,
            base,
            mode,
            vp,
            scheme,
            path,
            scroll,
            scrollTarget: target,
            ...analyse(frames, cls, paints),
          }
          results.push(result)
          const bad =
            result.error ||
            result.movers ||
            result.fades ||
            result.lateInViewport ||
            result.cls > 0 ||
            result.bgValues.length > 1 ||
            result.panelValues.length > 1 ||
            result.pageScrollValues.some((v) => v !== 0) ||
            (scroll === "top" && result.scrollValues.some((v) => v !== 0)) ||
            (scroll === "mid" &&
              (result.scrollValues.length !== 1 || Math.abs(result.scrollValues[0] - target) > 1))
          console.log(
            (bad ? "FAIL " : "ok   ") +
              [
                mode,
                vp,
                scheme,
                path,
                scroll,
                "cls=" + result.cls,
                "mov=" + result.movers,
                "fade=" + result.fades,
                "late=" + result.lateInViewport,
                "bg=" +
                  (result.bgValues || []).join("|") +
                  " panel=" +
                  (result.panelValues || []).join("|"),
                "scroll=" + (result.scrollValues || []).join(","),
                "target=" + target,
                "fonts=" +
                  (result.fontAtFirstPaint || []).length +
                  "/" +
                  (result.fontSettled || []).length,
                "strict=" + result.strictMoversFromFirstContentFrame,
                "paint=" + result.firstPaintMs,
                JSON.stringify(result.moversDetail || []),
              ].join(" "),
          )
          await ctx.close()
        }
      }
    }
  }
}
await browser.close()
writeFileSync(out + "/" + label + ".json", JSON.stringify(results, null, 1))
console.log(
  "DONE",
  results.length,
  "scenarios; failing:",
  results.filter(
    (r) =>
      r.error ||
      r.movers ||
      r.fades ||
      r.lateInViewport ||
      r.cls > 0 ||
      r.bgValues.length > 1 ||
      r.panelValues.length > 1,
  ).length,
)
```

```js
import { createRequire } from "node:module"
const require = createRequire(
  "/Users/dallenpyrah/Projects/rika-labs/akter-cloud/node_modules/.bun/playwright@1.63.0/node_modules/playwright/",
)
const pw = require("playwright")
const [base, engine, kind, iterations] = process.argv.slice(2)
const launch = () => pw[engine].launch(engine === "chromium" ? { channel: "chrome" } : {})

const rapidReload = async () => {
  const browser = await launch()
  let bad = 0
  const lines = []
  for (const [w, h] of [
    [390, 844],
    [1440, 900],
  ]) {
    let wrong = 0
    let worst = []
    for (let i = 0; i < Number(iterations); i++) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } })
      await ctx.addInitScript(
        "(" +
          function () {
            window.__y = []
            const t0 = performance.now()
            const tick = () => {
              const main = document.getElementById("ak-main")
              if (document.querySelector("h1") && main) window.__y.push(Math.round(main.scrollTop))
              if (performance.now() - t0 < 1500) requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
          } +
          ")()",
      )
      const page = await ctx.newPage()
      await page.goto(base + "/quickstart", { waitUntil: "load" })
      await page.reload({ waitUntil: "load" })
      const target = await page.evaluate(async () => {
        const m = document.getElementById("ak-main")
        m.scrollTop = Math.floor((m.scrollHeight - m.clientHeight) / 2)
        await new Promise((r) => setTimeout(r, 150))
        return Math.round(m.scrollTop)
      })
      await page.reload({ waitUntil: "load" })
      await page.waitForTimeout(1700)
      const ys = await page.evaluate(() => window.__y)
      const distinct = [...new Set(ys)]
      if (distinct.length !== 1 || Math.abs(distinct[0] - target) > 1) {
        wrong++
        worst = [target, distinct.slice(0, 5)]
      }
      await ctx.close()
    }
    bad += wrong
    lines.push(
      engine +
        " " +
        w +
        "x" +
        h +
        " rapid reload (scroll midway, wait 150 ms, reload): " +
        iterations +
        " runs, " +
        wrong +
        " lost or moved the position" +
        (wrong ? " e.g. target/observed " + JSON.stringify(worst) : ""),
    )
  }
  await browser.close()
  console.log(lines.join("\n") + "\n" + (bad === 0 ? "RAPID-OK" : "RAPID-BAD"))
}

const hydration = async () => {
  const browser = await launch()
  let bad = 0
  for (const [w, h] of [
    [390, 844],
    [1440, 900],
  ]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } })
    await ctx.route("**/*.js", async (route) => {
      const response = await route.fetch()
      await new Promise((r) => setTimeout(r, 3000))
      await route.fulfill({ response })
    })
    await ctx.addInitScript(
      "(" +
        function () {
          let changed = false
          new MutationObserver(() => {
            const h1 = document.querySelector("h1")
            if (h1 && !changed) {
              changed = true
              h1.textContent = "Changed before hydration"
            }
          }).observe(document, { childList: true, subtree: true })
        } +
        ")()",
    )
    const page = await ctx.newPage()
    const errors = []
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text().slice(0, 80))
    })
    const samples = []
    await page.goto(base + "/quickstart", { waitUntil: "commit" })
    for (let t = 0; t < 14; t++) {
      await page.waitForTimeout(1000)
      samples.push(
        await page
          .evaluate(() => {
            const h1 = document.querySelector("h1")
            return {
              t: Math.round(performance.now()),
              text: h1 ? h1.textContent : null,
              vis: h1 ? getComputedStyle(h1).visibility : null,
              htmlVis: getComputedStyle(document.documentElement).visibility,
              attrs: document.documentElement.getAttributeNames().join(","),
            }
          })
          .catch(() => ({ text: "navigating" })),
      )
    }
    const last = samples.at(-1)
    const recovered =
      last.text === "Quickstart" && last.vis === "visible" && last.htmlVis === "visible"
    const hiddenEver = samples.some((s) => s.vis === "hidden" || s.htmlVis === "hidden")
    if (!recovered || hiddenEver) bad++
    console.log(
      engine +
        " " +
        w +
        "x" +
        h +
        " delayed JS 3 s + forced mismatch: h1 first '" +
        samples[0].text +
        "', last '" +
        last.text +
        "', ever hidden=" +
        hiddenEver +
        ", html attributes at end '" +
        last.attrs +
        "', console errors seen=" +
        errors.length,
    )
    await ctx.close()
  }
  await browser.close()
  console.log(bad === 0 ? "HYDRATION-ATTACK-OK" : "HYDRATION-ATTACK-BAD")
}

await (kind === "rapid" ? rapidReload() : hydration())
```
