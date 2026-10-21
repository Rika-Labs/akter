# Declare, capture, compare

## Acceptance before the target diff

Give each state a stable ID. For each region declare geometry tolerances in CSS px, typography
(including resolved font evidence, size/weight/line-height/tracking and wrap), color-role mappings,
interaction/focus outcomes and exclusions with their approval. Default geometry tolerance: 0.5 CSS px
under identical conditions; a different tolerance needs a reason recorded before comparison. Exact
style equality or explicit reference → target mappings are separate from geometry. Behavior is a
recorded scenario, not a screenshot score. A screenshot reference cannot supply computed CSS.

Use screenshots for visual review and region diffs; percentage alone never decides acceptance. Tiny
controls disappear in large blank images, rasterization differs across browsers, and branding/content
can change many pixels intentionally. Keep mapped/excluded regions visible in the ledger; do not erase
arbitrary mismatches with masks. Stop a recording and remove overlays before clean captures.

## Reusable settled-capture utilities

The utility uses Python's standard library; its tests also use Node for the actual browser-expression
syntax and transform checks. It does not start a stack, launch a browser, sign in
or navigate. Use `browse-it` to open the actual state in your own already-active named agent-browser
session. Never point them at a shared/default/restored session; use sanitized content because screenshots
can expose secrets. Pass a **new absolute directory outside the repository** for each capture.

Example configuration, saved outside the repo (selectors differ between reference and target, IDs do not):

```json
{
  "state": "welcome/top/light/desktop",
  "regions": { "title": "h1", "search": "button[data-search]" },
  "fontTimeoutMs": 10000
}
```

From the repository root, replacing the example arguments:

```bash
python3 -B .agents/skills/match-it/scripts/match.py capture owned-session /absolute/config.json /absolute/new-capture
python3 -B .agents/skills/match-it/scripts/match.py compare /absolute/reference/measurement.json /absolute/target/measurement.json /absolute/acceptance.json
python3 -B -m unittest discover -s .agents/skills/match-it/scripts/test -p 'test_match.py'
```

The capture pins the active tab, waits at most the configured font deadline, then brackets a viewport
screenshot with observations. Changed observations or target, browser errors, missing/duplicate/hidden
selectors or regions outside the viewport fail. Output collisions fail; interrupted attempts lack
`complete.json` and are not evidence. Never consume them. The comparison CLI verifies the completion
manifest and screenshot/measurement hashes before comparing. This
best-effort consistency check is not atomic: an intervening change that returns to the same state may
escape it. It does not establish hydration/image completion or stability between observations.

The JSON contains only allowlisted computed properties, boxes and font metadata, never cookies, storage,
HTML, text content or page URLs. DOM visibility does not establish absence of occlusion. Captures record
visual-viewport scale and offsets; this scale is not browser zoom. Record browser zoom separately.
For an Aside reference, generate the same page expression with `python3 -B scripts/match.py source config.json`
(script path relative to this skill), evaluate it through `browse-it`, and bracket an owned screenshot
with identical observations manually. Preserve the same context and consistency evidence in a hashed
bundle; do not bypass the CLI's manifest check. Compare loaded observations through the module's
`compare(reference, target, acceptance)` function only after that manual evidence review.

Example acceptance file; declare checks for **all** required metrics, not only these examples:

```json
{
  "state": "welcome/top/light/desktop",
  "checks": [
    { "region": "title", "metric": "box.x", "tolerance": 0.5 },
    { "region": "title", "metric": "styles.fontSize" },
    { "region": "title", "metric": "styles.fontFamily" },
    {
      "region": "search",
      "metric": "styles.color",
      "reference": "rgb(0, 0, 0)",
      "target": "rgb(255, 190, 0)"
    }
  ]
}
```

The comparator validates the whole checklist, context and observations, rejects unknown metrics and
fails on missing/hidden regions, mismatched states or unready fonts. Geometry is an inclusive absolute
delta; styles require exact equality or both declared mapped values. It returns only
`MEASUREMENTS_PASS` for **declared geometry/style checks**; this is not full visual/behavioral acceptance.
Retain the checklist hash with the frozen evidence. A missing required check is still an incomplete task.

## Measurement boundaries

- Font faces and computed family names are diagnostics, not proof of the font actually rendering every
  glyph. Inspect font responses and rendered-font tooling where available. Unresolved fallback identity
  keeps the typography criterion unresolved, even when geometry/style checks pass.
- `rangeBoxes` are layout rectangles, not glyph ink or a baseline. Mixed fonts, multiline content,
  ligatures, combining marks, transforms and letter spacing invalidate naive canvas/Range ink estimates.
- `svgBoxes` transform all four corners of each shape's local geometry box using that shape's screen
  matrix. They are geometry bounds, **not** exact stroke, clipping, filter or raster ink, and not an
  envelope guaranteed to contain it. `ink` is explicitly `unmeasured`; the comparator rejects ink metrics.
- For red-line diagnostics use `align-it`'s measurement reference with those limitations. A precise ink
  criterion needs a validated raster/font method and its own failure controls; do not relabel estimates.
- Before trusting changed harness code, run the independent tests and real-browser negative controls:
  hidden/duplicate/offscreen selectors, a font deadline, changing geometry around capture, wrong fonts,
  rotated/sheared SVG shapes, and a tiny shifted control that a whole-page pixel score would miss.

Keep arrival/interaction evidence separate: [states.md](states.md). After independent acceptance,
`prove-it` checks the actual deployed artifact and browser delivery; local captures cannot replace it.
