import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --panel: #ffffff; --ink: #16181d; --muted: #6b7280; --line: #e3e6ea;
  --accent: #3b5bdb; --good: #2b8a3e; --bad: #c92a2a; --warn: #b7791f; --info: #1c7ed6;
  --code: #f1f3f5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --panel: #171a21; --ink: #e8eaed; --muted: #9aa0a6; --line: #2a2f39;
    --accent: #7c95ff; --good: #51cf66; --bad: #ff6b6b; --warn: #fcc419; --info: #4dabf7;
    --code: #1f232b;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, .mono, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
header.top { display: flex; align-items: center; gap: 16px; padding: 12px 24px; background: var(--panel); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 1; }
header.top .brand { font-weight: 650; letter-spacing: -0.01em; }
header.top .brand small { color: var(--muted); font-weight: 400; margin-left: 6px; }
header.top .spacer { flex: 1; }
header.top label, header.top .updated { color: var(--muted); font-size: 12.5px; }
header.top button { font: inherit; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--ink); cursor: pointer; }
.layout { display: grid; grid-template-columns: 200px 1fr; min-height: calc(100vh - 53px); }
nav.sections { padding: 16px 12px; border-right: 1px solid var(--line); display: flex; flex-direction: column; gap: 2px; }
nav.sections a { padding: 7px 10px; border-radius: 6px; color: var(--ink); }
nav.sections a.active { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); font-weight: 600; }
nav.sections .note { margin-top: 16px; padding: 0 10px; color: var(--muted); font-size: 12px; }
main { padding: 20px 24px 48px; min-width: 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; margin-bottom: 18px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; color: var(--ink); }
.tile strong { font-size: 20px; font-variant-numeric: tabular-nums; }
.tile span { color: var(--muted); font-size: 12px; }
.tile.alert { border-color: var(--bad); }
.tile.alert strong { color: var(--bad); }
.stack { display: flex; flex-direction: column; gap: 16px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; overflow-x: auto; }
.card.error { border-color: var(--bad); }
.card h2 { margin: 0 0 12px; font-size: 15px; display: flex; align-items: center; gap: 8px; }
.card h2 .count { color: var(--muted); font-weight: 500; font-size: 12.5px; background: var(--code); border-radius: 999px; padding: 1px 8px; }
.hero h1 { margin: 2px 0 10px; font-size: 20px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.crumbs { margin: 0; color: var(--muted); font-size: 12.5px; }
.facts { display: flex; gap: 6px; flex-wrap: wrap; }
.hint { color: var(--muted); margin: -4px 0 10px; font-size: 12.5px; }
.empty { color: var(--muted); margin: 4px 0; }
.muted { color: var(--muted); }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-weight: 600; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; padding: 6px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
td.num { font-variant-numeric: tabular-nums; text-align: right; }
td.cause { max-width: 420px; word-break: break-word; }
td.cause pre.trace { margin: 6px 0 0; font-size: 11.5px; color: var(--muted); white-space: pre-wrap; max-height: 220px; overflow: auto; }
td pre.json { min-width: 200px; }
td .due time { white-space: nowrap; }
.small { font-size: 11.5px; color: var(--muted); word-break: break-all; }
.badge { display: inline-block; max-width: 280px; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 550; background: var(--code); color: var(--ink); white-space: nowrap; }
.badge.good { background: color-mix(in srgb, var(--good) 16%, transparent); color: var(--good); }
.badge.bad { background: color-mix(in srgb, var(--bad) 16%, transparent); color: var(--bad); }
.badge.warn { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
.badge.info { background: color-mix(in srgb, var(--info) 16%, transparent); color: var(--info); }
.chip { display: inline-block; padding: 2px 9px; margin: 0 4px 4px 0; border: 1px solid var(--line); border-radius: 999px; font-size: 12px; color: var(--ink); background: var(--panel); cursor: pointer; font-family: inherit; }
.chip.active { border-color: var(--accent); color: var(--accent); }
.filters { margin-bottom: 10px; }
pre.json { margin: 0; padding: 8px 10px; background: var(--code); border-radius: 6px; max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
details summary { cursor: pointer; color: var(--accent); font-size: 12.5px; }
.due small { color: var(--muted); }
.due.overdue small { color: var(--warn); }
.state { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.state-entry h3 { margin: 0 0 6px; font-size: 13px; }
ol.timeline { list-style: none; margin: 0; padding: 0 0 0 14px; border-left: 2px solid var(--line); display: flex; flex-direction: column; gap: 10px; }
li.event { position: relative; }
li.event::before { content: ""; position: absolute; left: -20px; top: 6px; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
li.event.flash pre.json { outline: 2px solid var(--accent); }
.event-head { display: flex; gap: 10px; align-items: baseline; margin-bottom: 4px; flex-wrap: wrap; }
.event-head .seq { font-weight: 650; font-variant-numeric: tabular-nums; }
article.workflow { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; overflow-x: auto; }
article.workflow header { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
article.workflow h3 { margin: 0; font-size: 14px; }
article.workflow h4 { margin: 12px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); }
article.workflow dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 10px 0 0; }
article.workflow dt { color: var(--muted); }
article.workflow dd { margin: 0; }
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 800px) { .layout { grid-template-columns: 1fr; } nav.sections { flex-direction: row; flex-wrap: wrap; border-right: 0; border-bottom: 1px solid var(--line); } .split { grid-template-columns: 1fr; } }
`

const SECTIONS: ReadonlyArray<readonly [string, string, string]> = [
  ["#/actors", "/actor", "Actors"],
  ["#/outbox", "/outbox", "Outbox and timers"],
  ["#/jobs", "/jobs", "Jobs"],
  ["#/dead-letters", "/dead-letters", "Dead letters"],
  ["#/workflows", "/workflows", "Workflows"],
]

const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

/** The inspector's HTML shell; the bundled client fills it from the API under `api`. */
export const page = ({
  api,
  script,
}: {
  readonly api: string
  readonly script: string
}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>akter dev inspector</title>
<style>${STYLES}</style>
</head>
<body data-api="${escape(api)}">
<header class="top">
  <span class="brand">akter dev<small>inspector</small></span>
  <span class="badge info">tenant <strong id="tenant">…</strong></span>
  <span class="badge">read-only</span>
  <span class="spacer"></span>
  <span class="updated" id="updated"></span>
  <label><input type="checkbox" id="live"> live</label>
  <button type="button" id="refresh">Refresh</button>
</header>
<div class="layout">
  <nav class="sections">
    ${SECTIONS.map(([href, section, label]) => `<a href="${href}" data-section="${section}">${label}</a>`).join("\n    ")}
    <p class="note">Reads the durable inspection views. Nothing here writes.</p>
  </nav>
  <main>
    <div id="tiles"></div>
    <div id="app"><p class="empty">Loading…</p></div>
  </main>
</div>
<script type="module" src="${escape(script)}"></script>
</body>
</html>`

const CLIENT = new URL("./client.ts", import.meta.url).pathname

/** Bundles the browser client once, when the server starts. */
const bundle = Effect.promise(() =>
  Bun.build({ entrypoints: [CLIENT], target: "browser", minify: true }),
).pipe(
  Effect.flatMap((built) =>
    built.success && built.outputs[0] !== undefined
      ? Effect.promise(() => built.outputs[0]!.text())
      : Effect.die(
          new Error(
            `Cannot bundle the inspector client: ${built.logs.map((log) => log.message).join("\n")}`,
          ),
        ),
  ),
)

/** Serves the inspector page at `path` and its script beside it; the API lives at `${path}/api`. */
export const pageRoutes = (path: string) =>
  HttpRouter.use(
    Effect.fnUntraced(function* (router) {
      const script = yield* bundle
      const html = page({ api: `${path}/api`, script: `${path}/client.js` })

      yield* router.add("GET", path as HttpRouter.PathInput, () =>
        Effect.succeed(
          HttpServerResponse.text(html, {
            contentType: "text/html; charset=utf-8",
            headers: { "cache-control": "no-store" },
          }),
        ),
      )

      yield* router.add("GET", `${path}/client.js` as HttpRouter.PathInput, () =>
        Effect.succeed(
          HttpServerResponse.text(script, {
            contentType: "text/javascript; charset=utf-8",
            headers: { "cache-control": "no-store" },
          }),
        ),
      )
    }),
  )
