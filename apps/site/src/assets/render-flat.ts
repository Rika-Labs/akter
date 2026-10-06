import type { Drawing, Figure, Paint } from "@akter/ui/brand"
import { escapeMarkup } from "../escape-markup.ts"

/** Literal colours for each brand paint role, for images that cannot use the site's tokens. */
export const flatPalette: Readonly<Record<Paint, string>> = {
  ink: "#0b0d0b",
  face: "#fbf1d1",
  top: "#faf5e3",
  end: "#fceaae",
  none: "none",
}

/** Literal colours for the container on the crane's hoist, which carries the accent. */
export const hoistPalette: Readonly<Record<Paint, string>> = {
  ...flatPalette,
  face: "#ffc300",
  top: "#ffd54d",
  end: "#cc9c00",
}

const figure = (item: Figure, palette: Readonly<Record<Paint, string>>): string => {
  const attributes = Object.entries(item.attributes)
    .map(([name, value]) => ` ${name}="${escapeMarkup(String(value))}"`)
    .join("")
  const dashes = item.className === "water" ? ' stroke-dasharray="16 5 3 5"' : ""
  const opacity = item.opacity === undefined ? "" : ` opacity="${item.opacity}"`
  const stroke =
    item.stroke === "none"
      ? ""
      : ` stroke="${palette[item.stroke]}" stroke-width="${item.strokeWidth ?? 1}" stroke-linejoin="round"`

  return `<${item.tag} fill="${palette[item.fill]}"${stroke}${opacity}${dashes}${attributes}/>`
}

const render = (item: Drawing, palette: Readonly<Record<Paint, string>> = flatPalette): string => {
  if (!("children" in item)) return figure(item, palette)
  const inner = item.className === "hoist" ? hoistPalette : palette
  return `<g>${item.children.map((child) => render(child, inner)).join("")}</g>`
}

/**
 * Renders scene descriptors as plain SVG with literal colours and no animation, for the favicon
 * and the Open Graph image. Text figures are skipped because those images load no mono font.
 */
export const renderFlat = (items: ReadonlyArray<Drawing>): string =>
  items
    .flatMap((item) => ("children" in item || item.tag !== "text" ? [render(item)] : []))
    .join("")
