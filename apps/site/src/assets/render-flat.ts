import type { Drawing, Figure, Paint } from "@akter/ui/brand"
import { escapeMarkup } from "../escape-markup.ts"

/** Literal colours for each brand paint role, for images that cannot use the site's tokens. */
export const flatPalette: Readonly<Record<Paint, string>> = {
  ink: "#0b0d0b",
  face: "#fafaf9",
  top: "#f3f2ef",
  end: "#ebe9e4",
  none: "none",
}

const figure = (item: Figure): string => {
  const attributes = Object.entries(item.attributes)
    .map(([name, value]) => ` ${name}="${escapeMarkup(String(value))}"`)
    .join("")
  const dashes = item.className === "water" ? ' stroke-dasharray="16 5 3 5"' : ""
  const opacity = item.opacity === undefined ? "" : ` opacity="${item.opacity}"`
  const stroke =
    item.stroke === "none"
      ? ""
      : ` stroke="${flatPalette[item.stroke]}" stroke-width="${item.strokeWidth ?? 1}" stroke-linejoin="round"`

  return `<${item.tag} fill="${flatPalette[item.fill]}"${stroke}${opacity}${dashes}${attributes}/>`
}

const render = (item: Drawing): string =>
  "children" in item ? `<g>${item.children.map(render).join("")}</g>` : figure(item)

/**
 * Renders scene descriptors as plain SVG with literal colours and no animation, for the favicon
 * and the Open Graph image. Text figures are skipped because those images load no mono font.
 */
export const renderFlat = (items: ReadonlyArray<Drawing>): string =>
  items
    .flatMap((item) => ("children" in item || item.tag !== "text" ? [render(item)] : []))
    .join("")
