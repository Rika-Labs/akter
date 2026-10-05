import { mark, markViewBox } from "@akter/ui/brand"
import { Resvg } from "@resvg/resvg-js"
import { portScene } from "../illustrations/scenes.ts"
import { fontFiles } from "./fonts.ts"
import { flatPalette, renderFlat } from "./render-flat.ts"

const markStrokes = (stroke: string): string =>
  mark
    .map((item) => {
      const width = ` stroke-width="${item.strokeWidth}" stroke-linecap="round"${stroke}`

      return item.tag === "polyline"
        ? `<polyline points="${item.attributes["points"]}" fill="none" stroke-linejoin="round"${width}/>`
        : `<line x1="${item.attributes["x1"]}" y1="${item.attributes["y1"]}" x2="${item.attributes["x2"]}" y2="${item.attributes["y2"]}"${width}/>`
    })
    .join("")

/** The favicon: the segmented mark in ink, switching to light ink on dark browser chrome. */
export const faviconSvg = (): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${markViewBox}"><style>g{stroke:${flatPalette.ink}}@media (prefers-color-scheme:dark){g{stroke:#ecebe7}}</style><g>${markStrokes("")}</g></svg>`

const raster = async (svg: string, width: number): Promise<Uint8Array> => {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: {
      fontFiles: [...(await fontFiles())],
      loadSystemFonts: false,
      defaultFontFamily: "PolySansVariable",
    },
  })

  return resvg.render().asPng()
}

/** The touch icon: the mark in ink on stone, as a 180-pixel PNG. */
export const touchIcon = (): Promise<Uint8Array> =>
  raster(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180"><rect width="180" height="180" fill="#fafaf9"/><g transform="translate(30 30) scale(4.286)" fill="none" stroke="${flatPalette.ink}">${markStrokes("")}</g></svg>`,
    180,
  )

const lines = ["Durable, stateful backends", "for realtime apps, background", "work, and agents."]

/**
 * The Open Graph card, drawn from the brand: the mark and wordmark, the headline in PolySans, and
 * the container port across the bottom, square-cornered on the page colour.
 */
export const openGraphImage = (): Promise<Uint8Array> =>
  raster(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <defs><clipPath id="card"><rect x="24" y="24" width="1152" height="582"/></clipPath></defs>
  <rect width="1200" height="630" fill="#fafaf9"/>
  <rect x="24.5" y="24.5" width="1151" height="581" fill="none" stroke="#37301f" stroke-opacity="0.13"/>
  <g clip-path="url(#card)"><g transform="translate(114 372) scale(0.9)" opacity="0.85">${renderFlat(portScene)}</g></g>
  <g transform="translate(84 70) scale(2.5)" fill="none" stroke="${flatPalette.ink}">${markStrokes("")}</g>
  <text x="170" y="126" font-family="PolySansVariable" font-weight="620" font-size="66" letter-spacing="-2.6" fill="${flatPalette.ink}">akter</text>
  ${lines.map((line, index) => `<text x="84" y="${216 + index * 58}" font-family="PolySansVariable" font-weight="450" font-size="52" letter-spacing="-2" fill="${flatPalette.ink}">${line}</text>`).join("\n  ")}
</svg>`,
    1200,
  )
