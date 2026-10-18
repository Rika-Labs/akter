# Docs appearance and first-paint evidence

**Responsibility:** bound the public documentation's first-paint, theme, navigation and font-loading claims.

**Authority:** evidence.

**Owner role:** documentation.

**Change policy:** rerun the measurement matrix below when `apps/docs` layout, its stylesheet, the Fumadocs version or the font source changes.

## Claims

The public docs are the static export of `apps/docs`. The page the browser receives is complete: every element a reader sees on first paint is in the server-rendered HTML.

1. The theme follows `prefers-color-scheme` in CSS, with no script and no saved choice. No frame shows the other theme, and the background never changes during load.
2. After the first paint no element moves by more than 0.5 px, changes size, or fades, on a load or a refresh, including a refresh that restores a mid-page scroll position.
3. A late font never swaps in. PolySans is embedded in the stylesheet, so there is no request to wait for, and the page is held hidden until the font is decoded; if the font fails or takes longer than 1.5 s the page shows in the fallback face for that load and `font-display: optional` keeps it there.
4. Nothing animates in on load: no entrance transition, no hydration-time swap of visible text.

## Environment and method

Collected on 2026-10-17 and 2026-10-18 on macOS 26.6.2 (arm64), Google Chrome 155.0.8059.80 and Playwright's WebKit 26.6, both driven by Playwright 1.63.0, Bun 1.4.2, Node 26.7.0, Next.js 16.4.2 and fumadocs-ui 16.17.5. The export was served by a small static server that applies `_redirects` and `_headers`, so the policy was in force for the measurements; the dev run used `next dev`.

The harness (the appendix) records every animation frame from document start until 3.5 s after navigation. In each frame it reads the document-coordinate rectangle and the effective opacity of every `h1`, `h2`, `h3`, `p`, `li`, `a`, `button`, `header`, `nav`, `aside`, `main`, `footer`, `iframe`, `img`, `pre` and `table`, keyed by tag and visible text, and skips elements that are `visibility: hidden`. It also records the `html` and `body` background colours, the scroll offset, which fonts are loaded, and `layout-shift` entries from the browser. A scenario passes only if all of the following hold: no element present in the first content frame differs from its settled rectangle by more than 0.5 px, none changes opacity, none appears inside the viewport later, the layout-shift total is 0, the background takes one value, and the scroll offset takes one value, equal to the offset before the reload, from the first content frame on.

The matrix is the product of: pages `/welcome`, `/quickstart` and `/api/01-server-api`; viewports 1440 × 900 and 390 × 800; schemes dark and light; scroll top, and scrolled to the middle then reloaded so the browser restores the offset; and PolySans blocked (request aborted), available at once, and delayed 1500 ms (answered with the CORS header the live origin sends).

## Results

| Build                   | Scenarios | Failing | Frames recorded | Moved or resized elements | Fades | Late in viewport | Layout shift | Backgrounds seen                    | Scroll changes |
| ----------------------- | --------- | ------- | --------------- | ------------------------- | ----- | ---------------- | ------------ | ----------------------------------- | -------------- |
| Static export, Chromium | 72        | 0       | 15,108          | 0                         | 0     | 0                | 0            | rgb(18, 19, 17), rgb(251, 251, 250) | 0              |
| Static export, WebKit   | 72        | 0       | 14,906          | 0                         | 0     | 0                | 0            | rgb(18, 19, 17), rgb(251, 251, 250) | 0              |
| `next dev`              | 48        | 0       | 6,181           | 0                         | 0     | 0                | 0            | rgb(18, 19, 17), rgb(251, 251, 250) | 0              |

Dark scenarios saw only `rgb(18, 19, 17)` and light scenarios only `rgb(251, 251, 250)`; no scenario saw white in dark. First content appeared between 21 ms and 56 ms after navigation start on the export in Chromium and between 29 ms and 364 ms in WebKit, where the gate waits for the font to decode. One Chromium run of the 72 scenarios showed the desktop sidebar one frame after the rest of the page in one scenario (`/api/01-server-api`, slow font mode); a second full run had none, and 96 repeats of the scenario on this build and 96 on the build before the font change had none, so it is recorded here as unexplained. The font modes no longer change anything, because the export makes no request for the font; they stay in the matrix to show that. The dev run covered the delayed and blocked font cases only, and ran before the fallback calibration below.

With JavaScript disabled, the quickstart renders its heading, navbar, 20 sidebar links and code in the correct theme for both preferences, so the first paint does not depend on a script.

## Defects the measurement found

Each was reproduced, fixed at its cause and re-measured; the matrix above is the run after the last fix.

| Observation                                                                                                                                                                                                                                                                                                                            | Cause                                                                                                                                                                                                                                                                                                                                                                                                  | Fix and result                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| On a reload that restores a scroll offset, the first frame sat at the wrong offset (an extra 86 px on mobile, double the offset on desktop) and corrected itself one to three frames later, in 8 to 23 of every 100 reloads. Content positions did not change.                                                                         | Scroll anchoring during Chrome's history scroll restoration (inferred: it never occurred with page scripts removed and it stopped when anchoring was off on every element).                                                                                                                                                                                                                            | `overflow-anchor: none` on every element. 0 of 100 reloads on desktop and on mobile afterwards. Setting it on the root alone did not remove it.                                                                                                                                                                                                                                                                                                                                |
| The mobile contents bar changed its label from the page name to the active heading after hydration, with a slide transition and an animating progress circle.                                                                                                                                                                          | The Fumadocs trigger renders the scroll-spy state on the client.                                                                                                                                                                                                                                                                                                                                       | The label is the page name only, the progress circle is hidden and transitions are off in the contents bars.                                                                                                                                                                                                                                                                                                                                                                   |
| The mobile contents bar could paint a few milliseconds after the heading.                                                                                                                                                                                                                                                              | Chrome painted a half-parsed document.                                                                                                                                                                                                                                                                                                                                                                 | A render-blocking `<link rel="expect" href="#end-of-page" blocking="render">` holds the first paint until the parser reaches the end marker.                                                                                                                                                                                                                                                                                                                                   |
| On a reload that restores a scroll offset, WebKit painted the first frames at the top and jumped to the offset once the page scripts had loaded: 36 of 36 reloads before the fix, with the first content frame at offset 0 every time.                                                                                                 | WebKit restores its own offset only after the document finishes loading, which waits for the async page scripts, and it does not honour the `expect` link.                                                                                                                                                                                                                                             | An inline script before the end marker restores the saved offset from `sessionStorage` on reload and back or forward loads. 36 of 36 reloads start at the offset afterwards, in WebKit and in Chromium.                                                                                                                                                                                                                                                                        |
| On a 390 px screen the copy button sat over the first line of 9 of 21 code blocks.                                                                                                                                                                                                                                                     | The button is positioned over the top right of the block and a long first line ran under it.                                                                                                                                                                                                                                                                                                           | The code region has 2.75 rem of top padding below 40 rem. 0 of 21 afterwards; desktop stayed at 0 of 21.                                                                                                                                                                                                                                                                                                                                                                       |
| On a first load with PolySans on another origin, WebKit painted the fallback face and reflowed up to 28 px when the font arrived: 38 of 40 cold loads of `/guides/concepts` and `/quickstart` with the font origin at 90 ms, and sometimes the font ended in the `error` state and the page stayed on the fallback. Chromium: 0 of 40. | WebKit paints before a font file requested during the first layout has arrived, and it does not honour `expect`; even a `data:` font in the stylesheet is decoded a tick after the first style recalculation, and 9 of 15 cold loads with `font-display: optional` and 2 of 15 with `block` still painted the fallback. A same-origin file lost the same race when it was 150 ms slower than the page. | The font is embedded in the stylesheet and `html` starts gated until the font is decoded (an attribute, lifted by a small inline script, with a 1.5 s backstop and a `noscript` override). 0 of 40 cold loads in WebKit and 0 of 40 in Chromium afterwards. A gate built as an element instead of an attribute made React rebuild the page when the script removed it before hydration, which left the page hidden; that was found by the matrix and fixed before this result. |
| The mobile drawer appeared to move 331 px at hydration.                                                                                                                                                                                                                                                                                | It is `visibility: hidden`, replaced from the server-rendered sidebar and slid off-canvas. A harness artefact.                                                                                                                                                                                                                                                                                         | The harness skips hidden elements.                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Font fallback

PolySans is fetched at build time from the font origin (`https://akter.dev/fonts/PolySans-variable.woff2` by default), embedded in the stylesheet and not committed. The stylesheet declares a local fallback family, `PolySans Fallback`, built from Arial or a metric-compatible face so it exists on macOS, Windows, Linux and Android: a regular face for weights 300 to 500 at `size-adjust: 102.29%` and a bold face for 600 to 800 at `size-adjust: 97.9%`, with ascent and descent overrides from the font's own metrics.

Measured on 20 paragraphs and headings of the quickstart at 16 px, the width of each text relative to real PolySans:

| Face                          | Mean, weight 400 | Range, weight 400 | Mean, weight 600 | Range, weight 600 |
| ----------------------------- | ---------------- | ----------------- | ---------------- | ----------------- |
| `PolySans Fallback`           | 1.0002           | 0.975 to 1.019    | 0.9998           | 0.975 to 1.019    |
| Arial, unadjusted             | 0.978            | 0.953 to 0.997    | 1.022            | 0.996 to 1.041    |
| `ui-sans-serif` (SF on macOS) | 0.998            | 0.982 to 1.006    | 1.014            | 1.002 to 1.021    |

The first calibration, from letter-frequency estimates, was 1.8% too wide at weight 400; it was replaced with the measured values above. The fallback matches on average, but per-text width still differs by up to 2.5%, so a page rendered with the fallback wraps one block differently from the PolySans render on some pages: the document height differed by 27 to 28 px on 3 of 6 page and viewport pairs, and by 0 on the other 3. On macOS the system face matched wrapping on all 6 pairs, but its metrics on other platforms were not measured, so the portable fallback stays. This difference only shows between a load that used the fallback and a load that used PolySans; inside one load nothing changes.

## Other checks

- Keyboard: the search shortcut opens the dialog, typing returns results, an arrow key and Enter navigate to the page; Tab walks the logo, search, Sign in, GitHub, sidebar toggle, the three tabs and the sidebar links in order, and the focused element shows a ring.
- Code blocks colour tokens with CSS variables (four distinct colours in each theme), the copy button writes the code to the clipboard, and Copy Markdown copies the page's Markdown with its source link.
- An unknown address returns the on-theme 404 page with status 404 (the hosting uses 404-page handling); the file address `/404` answers 200 because it is the page file itself. The export has 38 pages and 38 Markdown twins, equal as sets, and the published set equals the old navigation.
- A dead link or a missing anchor in a published page fails the build.

## Not verified

- Safari itself and Firefox. WebKit was measured through Playwright's build, which is not Safari; Firefox was not run.
- The Cloudflare edge itself. The export was served by a local server that emulates `_redirects`, extensionless URLs and `_headers`. The policy was exercised in Chromium (no violation on 7 pages at desktop and mobile widths with search, copy and page actions used), but the edge, its header handling and its cache were not.
- Real networks. The first paint now waits for a stylesheet that carries the font; local runs with 60 ms added to every response show first content at 75 to 213 ms in WebKit and 145 to 152 ms in Chromium, but a slow connection will wait longer for the font than the old design did, in return for never painting the fallback first.
- The desktop contents list marks the active heading after hydration (a colour change and a marker, with transitions off). It is scroll-position state and is not part of first paint.
- Hosted search quality and the cutover itself.

## Appendix: measurement harness

Run `ENGINE=<chromium or webkit> POLYSANS_FILE=<path to PolySans-variable.woff2> node measure.mjs <base URL> <label> <pages> <font modes>` with the export served at the base URL; results are written as JSON and a PASS or FAIL line per scenario is printed.

```js
import { writeFileSync, mkdirSync } from "node:fs"
import playwright from "playwright"

const engine = process.env.ENGINE ?? "chromium"

const base = process.argv[2]
const label = process.argv[3]
const pages = (process.argv[4] ?? "/welcome,/quickstart,/api/01-server-api").split(",")
const fontModes = (process.argv[5] ?? "blocked,fast,slow").split(",")
const out = process.env.MEASURE_OUT ?? "measure"
mkdirSync(out, { recursive: true })
const polySans = process.env.POLYSANS_FILE
const STOP_MS = 3500

const recorder =
  "(" +
  function (stopMs) {
    const frames = []
    window.__frames = frames
    window.__cls = 0
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value
      }).observe({ type: "layout-shift", buffered: true })
    } catch {}
    const selector = "h1,h2,h3,p,li,a,button,header,nav,aside,main,footer,iframe,img,pre,table"
    const effectiveOpacity = (el) => {
      let o = 1
      for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity)
      return o
    }
    const snap = () => {
      const root = document.documentElement
      const body = document.body
      const rects = {}
      const counts = {}
      let visible = 0
      if (body) {
        for (const el of document.querySelectorAll(selector)) {
          const r = el.getBoundingClientRect()
          const text = (el.innerText || "").trim().slice(0, 40)
          const key = el.tagName + "|" + text
          counts[key] = (counts[key] || 0) + 1
          if (r.width === 0 && r.height === 0) continue
          if (getComputedStyle(el).visibility === "hidden") continue
          visible++
          rects[key + "#" + counts[key]] = [
            r.x + scrollX,
            r.y + scrollY,
            r.width,
            r.height,
            effectiveOpacity(el),
          ]
        }
      }
      frames.push({
        t: performance.now(),
        scrollY: window.scrollY,
        vh: window.innerHeight,
        bg: root ? getComputedStyle(root).backgroundColor : null,
        bodyBg: body ? getComputedStyle(body).backgroundColor : null,
        visible,
        h1: !!(body && body.querySelector("h1")),
        loadedFonts: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
        rects,
      })
    }
    const loop = () => {
      snap()
      if (performance.now() < stopMs) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  } +
  ")(" +
  STOP_MS +
  ")"

function analyse(frames, cls) {
  const first = frames.findIndex((f) => f.h1 && Object.keys(f.rects).length > 10)
  if (first < 0) return { error: "no content frame", frames: frames.length }
  const settled = frames[frames.length - 1]
  const viewportBottom = (f) => f.scrollY + f.vh
  const movers = []
  const fades = []
  for (const key of Object.keys(frames[first].rects)) {
    let worst = 0
    let lo = 1
    let hi = 0
    for (const f of frames.slice(first)) {
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
    if (frames[first].rects[key]) continue
    const s = settled.rects[key]
    if (s[1] < viewportBottom(settled)) late.push(key)
  }
  const bgs = new Set()
  for (const f of frames) {
    bgs.add(f.bg)
    bgs.add(f.bodyBg)
  }
  const afterFirst = frames.slice(first)
  return {
    frames: frames.length,
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
    scrollValues: [...new Set(afterFirst.map((f) => Math.round(f.scrollY)))],
    cls: +cls.toFixed(4),
    fontAtFirstContent: frames[first].loadedFonts.filter((f) => f.includes("PolySans")),
    fontSettled: settled.loadedFonts.filter((f) => f.includes("PolySans")),
  }
}

const browser = await playwright[engine].launch(engine === "chromium" ? { channel: "chrome" } : {})
const results = []
for (const fontMode of fontModes) {
  for (const [vp, w, h] of [
    ["desktop", 1440, 900],
    ["mobile", 390, 800],
  ]) {
    for (const scheme of ["dark", "light"]) {
      for (const path of pages) {
        for (const scroll of ["top", "mid"]) {
          const ctx = await browser.newContext({
            viewport: { width: w, height: h },
            colorScheme: scheme,
          })
          await ctx.route("https://akter.dev/fonts/**", async (route) => {
            if (fontMode === "blocked") return route.abort()
            if (fontMode === "slow") await new Promise((r) => setTimeout(r, 1500))
            return route.fulfill({
              path: polySans,
              headers: { "access-control-allow-origin": "*", "content-type": "font/woff2" },
            })
          })
          const page = await ctx.newPage()
          await page.goto(base + path, { waitUntil: "networkidle" })
          if (scroll === "mid") {
            await page.evaluate(() =>
              window.scrollTo(
                0,
                Math.floor((document.documentElement.scrollHeight - innerHeight) / 2),
              ),
            )
            await page.waitForTimeout(400)
          }
          const target = await page.evaluate(() => Math.round(scrollY))
          await page.addInitScript(recorder)
          await page.reload({ waitUntil: "load" })
          await page.waitForTimeout(STOP_MS + 400)
          const { frames, cls } = await page.evaluate(() => ({
            frames: window.__frames,
            cls: window.__cls,
          }))
          const result = {
            label,
            base,
            fontMode,
            vp,
            scheme,
            path,
            scroll,
            scrollTarget: target,
            ...analyse(frames, cls),
          }
          results.push(result)
          const bad =
            result.error ||
            result.movers ||
            result.fades ||
            result.lateInViewport ||
            result.cls > 0 ||
            result.bgValues.length > 1 ||
            (scroll === "top" && result.scrollValues.some((v) => v !== 0)) ||
            (scroll === "mid" &&
              (result.scrollValues.length !== 1 || Math.abs(result.scrollValues[0] - target) > 1))
          console.log(
            (bad ? "FAIL " : "ok   ") +
              [
                fontMode,
                vp,
                scheme,
                path,
                scroll,
                "cls=" + result.cls,
                "mov=" + result.movers,
                "fade=" + result.fades,
                "late=" + result.lateInViewport,
                "bg=" + (result.bgValues || []).join("|"),
                "scroll=" + (result.scrollValues || []).join(","),
                "font1=" +
                  (result.fontAtFirstContent || []).length +
                  "/" +
                  (result.fontSettled || []).length,
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
    (r) => r.error || r.movers || r.fades || r.lateInViewport || r.cls > 0 || r.bgValues.length > 1,
  ).length,
)
```
