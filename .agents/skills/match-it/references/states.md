# Freeze the experience

Keep the inventory and evidence outside the repository. Capture a live reference through `browse-it`;
use an owned tab, the repository's profile policy and no auth-state exports. A screenshot-only reference
cannot establish hidden menus, transitions or responsive behavior: request those references or mark the
required comparisons blocked. N/A means the surface does not exist, with evidence, not "not checked".

## Inventory before implementation

For every route or page family, list the states below. Mark required, excluded with approval, or N/A
with a reason. Capture each required combination that changes appearance or behavior; name representative
routes explicitly rather than claiming all routes from one page.

| Surface    | States to discover                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| Arrival    | Cold and warm entry, direct deep link, first visible content, fonts and images, theme selection before paint |
| Shell      | Header, sidebar, inset/radii, active item, collapse/expand, page top and scrolled position                   |
| Navigation | Every tab/switcher/menu, anchor, external destination, unknown route, Back/Forward and direct reload         |
| Search     | Closed, keyboard open, each tab, empty query, results, no results, failed query, selection and Escape        |
| Controls   | Default, hover, focus-visible, pressed, open, selected, disabled and error where present                     |
| Theme      | Light, dark, system; persistence after reload and navigation; system preference change                       |
| Mobile     | Drawer closed/open, overflow, scroll locking, keyboard, focus return and width-boundary transitions          |
| Content    | Long titles, wrapping, code, tables, lists, long pages and bottom-of-page controls                           |

For each capture retain URL or source SHA, screenshot hash, browser/version, viewport in CSS px, DPR,
zoom, theme, reduced-motion preference, scroll, data, focused element and interaction recipe. Freeze the
original capture; corrections create a new reference version and an explicit ledger entry.

## Arrival is a different experiment

- Start recording on an owned blank tab **before** navigating or reloading. The optional URL argument
  to `agent-browser record start` navigates before recording; it is not cold-arrival evidence.
- Use an isolated session for cache clearing, font/request delays, offline and failures. Never alter a
  shared signed-in profile. Record exactly what was cleared; a new tab does not guarantee a cold cache.
- Exercise direct entry, same-route reload at the top and mid-page, navigation from another route,
  Back/Forward, and persisted light/dark/system selection. Repeat at desktop/mobile sizes.
- Record the first visible frame and subsequent sampled frames; inspect font swaps, theme flashes,
  scroll restoration, top jumps, hydration errors and layout-shift entries. Record the observation
  window and actual frame rate. Do not discard early frames to make a comparison pass.
- If a browser driver cannot capture before navigation, say so and use a suitable pre-navigation trace
  or recording tool. A post-load recording proves only its observed interval. Layout-shift entries can
  miss scroll jumps and visual theme changes; they are not a substitute for frames and scroll positions.

## A reviewable ledger

One row per discrepancy: state ID, region, reference artifact, target artifact, criterion, measured
difference, disposition (`open`, `fixed`, `approved difference`, `blocked`), and confirming evidence.
Keep open and blocked rows visible. Freeze the acceptance bundle for the verifier; a changed shared
font or shell requires all states using it to be rechecked, not just the last edited control.
