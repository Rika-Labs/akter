import type { Attribute, HtmlBuilder } from "foldkit/html"

/** Two density steps: the default and a compact one for dense tables and live tails. */
export type Density = "default" | "compact"

/**
 * Region opt-in for compact density: carries `data-density`, which compact fragments observe through
 * `densityMarker`. Compose `densityMarker` in the same element's single `styleAttributes` call.
 * Explicit component size variants win over region density.
 */
export const densityAttributes =
  (density: Density) =>
  <Message>(h: HtmlBuilder<Message>): ReadonlyArray<Attribute<Message>> => [
    h.DataAttribute("density", density),
  ]
