import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export function transformedBox(box, matrix) {
  if (
    ![
      box.x,
      box.y,
      box.width,
      box.height,
      ...["a", "b", "c", "d", "e", "f"].map((k) => matrix[k]),
    ].every(Number.isFinite) ||
    box.width < 0 ||
    box.height < 0
  )
    throw new Error("Invalid box or transform")
  const points = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height],
  ].map(([x, y]) => [
    matrix.a * x + matrix.c * y + matrix.e,
    matrix.b * x + matrix.d * y + matrix.f,
  ])
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1])
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  }
}

export const styleNames = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontStretch",
  "fontFeatureSettings",
  "fontVariationSettings",
  "lineHeight",
  "letterSpacing",
  "textTransform",
  "textAlign",
  "direction",
  "whiteSpace",
  "color",
  "backgroundColor",
  "borderRadius",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderTopColor",
  "boxShadow",
  "opacity",
  "transform",
]

async function measurePage(config, mapBox, names) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Font readiness deadline exceeded")),
      config.fontTimeoutMs ?? 10000,
    )
    document.fonts.ready.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
  const rect = (b) => ({ x: b.x, y: b.y, width: b.width, height: b.height })
  const regions = Object.fromEntries(
    Object.entries(config.regions).map(([id, selector]) => {
      const found = document.querySelectorAll(selector)
      if (found.length !== 1) throw new Error(`${id}: selector must match exactly one element`)
      const el = found[0],
        box = rect(el.getBoundingClientRect()),
        cs = getComputedStyle(el)
      const visible =
        box.width > 0 &&
        box.height > 0 &&
        cs.visibility === "visible" &&
        cs.display !== "none" &&
        cs.opacity !== "0" &&
        el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) !== false
      if (!visible) throw new Error(`${id}: element is hidden or has no area`)
      if (
        box.x < 0 ||
        box.y < 0 ||
        box.x + box.width > innerWidth ||
        box.y + box.height > innerHeight
      )
        throw new Error(`${id}: region is not wholly inside the viewport capture`)
      const range = document.createRange()
      range.selectNodeContents(el)
      const svgBoxes = [
        ...el.querySelectorAll("svg :is(path,circle,ellipse,rect,line,polyline,polygon)"),
      ]
        .filter((s) => !s.closest("defs,clipPath,mask,symbol"))
        .map((s) => {
          const m = s.getScreenCTM()
          return m ? mapBox(s.getBBox(), m) : null
        })
      return [
        id,
        {
          box,
          visible,
          styles: Object.fromEntries(names.map((k) => [k, cs[k]])),
          rangeBoxes: [...range.getClientRects()].map(rect),
          svgBoxes,
          ink: "unmeasured",
        },
      ]
    }),
  )
  return {
    schema: 1,
    state: config.state,
    documentIdentity: performance.timeOrigin,
    context: {
      mode: "viewport",
      coordinates: "css-viewport",
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      scale: visualViewport?.scale ?? 1,
      scrollX,
      scrollY,
      visualOffsetX: visualViewport?.offsetLeft ?? 0,
      visualOffsetY: visualViewport?.offsetTop ?? 0,
      userAgent: navigator.userAgent,
      colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "reduce"
        : "no-preference",
    },
    fonts: {
      status: document.fonts.status,
      faces: [...document.fonts].map((f) => ({
        family: f.family,
        weight: f.weight,
        style: f.style,
        status: f.status,
      })),
    },
    regions,
  }
}

export function measurementSource(config) {
  if (
    typeof config?.state !== "string" ||
    !config.state.trim() ||
    !config.regions ||
    Array.isArray(config.regions) ||
    typeof config.regions !== "object" ||
    !Object.keys(config.regions).length ||
    Object.entries(config.regions).some(([k, v]) => !k.trim() || typeof v !== "string" || !v.trim())
  )
    throw new Error("Expected a state and nonempty named selectors")
  if (
    config.fontTimeoutMs !== undefined &&
    (!Number.isFinite(config.fontTimeoutMs) ||
      config.fontTimeoutMs < 1 ||
      config.fontTimeoutMs > 30000)
  )
    throw new Error("fontTimeoutMs must be between 1 and 30000")
  return `(${measurePage.toString()})(${JSON.stringify(config)}, ${transformedBox.toString()}, ${JSON.stringify(styleNames)})`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3)
    throw new Error("Usage: node measure.mjs config.json > /absolute/measure.js")
  console.log(measurementSource(JSON.parse(readFileSync(process.argv[2], "utf8"))))
}
