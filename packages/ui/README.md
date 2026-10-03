# @akter/ui

Akter's design system: semantic StyleX tokens, FoldKit components with explicit variants, owned SVG
charts and diagrams, and framework-free brand and chart geometry. Apps compile it from TypeScript
source with `@stylexjs/unplugin`; there is no build step here.

## Entries

| Entry                      | What it holds                                                                    |
| -------------------------- | -------------------------------------------------------------------------------- |
| `@akter/ui`                | Components, the `styleAttributes` adapter, motion and accessibility fragments    |
| `@akter/ui/charts`         | Line/area, sparkline, bar, comparison, meter, histogram, lifecycle, rollout, map |
| `@akter/ui/geometry`       | Scales, ticks, paths, histogram quantiles, diagram layouts, number formats       |
| `@akter/ui/brand`          | The segmented Ak mark and container, quay, water, crane and stack drawings       |
| `@akter/ui/tokens.stylex`  | `colors`, `space`, `typography`, `radius`, `borders`, `shadows`, `motion`, …     |
| `@akter/ui/markers.stylex` | StyleX markers for density, hover reveal and the drawer                          |
| `@akter/ui/base.css`       | Font faces, reset and document defaults, layered before StyleX                   |
| `@akter/ui/fonts/*.woff2`  | PolySans, Sagittaire Display and Geist Mono, each named explicitly               |

`geometry` and `brand` import neither StyleX nor FoldKit, so the website can draw the same charts
and illustrations with its own renderer.

## Rules

- Components consume semantic roles from `tokens.stylex.ts`, never palette values. Colours are
  `light-dark()` pairs; the document's `color-scheme` chooses the theme.
- `styleAttributes(h, ...styles)` is the one FoldKit adapter. Each element resolves its styles in a
  single call; nothing joins class names or writes inline CSS by hand. Inline values come only from
  dynamic StyleX functions carrying data-derived geometry such as a chart point's position.
- A caller passes `style` (a `LayoutStyles` subset: placement and size only) and non-style
  `attributes`. A different look is a named variant on the component, not an override.
- Restraint: 4, 6 and 8 px radii; status is a dot and a word; colour is reserved for failure and
  warning. Charts are ink on hairline grids, with the highlighted series in ink and the rest grey.
- Motion uses the `motion` tokens and `motionStyles`/`entranceStyles`. Reduced motion keeps the
  state change and drops travel: chart draw-ins, water, cranes and pulses stop.
- Accessibility: every icon-only control has a label, charts carry a text summary for assistive
  technology, tables are `role="table"` with headers, and dialogs trap focus through FoldKit's
  `Dom.showDialog`.
- Density has two steps; a region opts into compact with `densityMarker` and
  `densityAttributes("compact")`.
