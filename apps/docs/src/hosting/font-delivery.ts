/** One font preload link of a page, as the attributes the browser reads. */
export interface FontPreload {
  readonly href: string
  readonly type: string | undefined
  readonly crossorigin: boolean
}

const attributes = (tag: string): ReadonlyMap<string, string> =>
  new Map(
    [...tag.matchAll(/([a-z-]+)="([^"]*)"/gi)].flatMap((match): ReadonlyArray<[string, string]> =>
      match[1] === undefined || match[2] === undefined ? [] : [[match[1].toLowerCase(), match[2]]],
    ),
  )

/**
 * The font preload links in the head of a page, as written. Next writes one for each font file
 * of the export on every page it renders from a route, so a page that names fewer than the two
 * faces would load a font after the first layout.
 */
export const fontPreloadTags = (html: string): ReadonlyArray<string> =>
  (html.slice(0, html.indexOf("</head>")).match(/<link\b[^>]*>/g) ?? []).filter((tag) => {
    const found = attributes(tag)

    return found.get("rel") === "preload" && found.get("as") === "font"
  })

/** The font preloads of a page as the attributes the browser reads. */
export const fontPreloads = (html: string): ReadonlyArray<FontPreload> =>
  fontPreloadTags(html).map((tag) => {
    const found = attributes(tag)

    return {
      href: found.get("href") ?? "",
      type: found.get("type"),
      crossorigin: found.has("crossorigin"),
    }
  })

/** A page with the given links added at the end of its head. */
export const withFontPreloads = (html: string, tags: ReadonlyArray<string>): string =>
  html.replace("</head>", `${tags.join("")}</head>`)

/**
 * Why a page's font preloads are wrong, or nothing when they are right: both faces, each a
 * same-origin file of the export under the media directory whose name ends in a hash and
 * .woff2, loaded in the mode a font request uses. A link without the anonymous cross-origin
 * mode is fetched a second time when the stylesheet asks for the face.
 */
export const fontPreloadProblems = (html: string, faces: number): ReadonlyArray<string> => {
  const links = fontPreloads(html)

  return [
    ...(links.length === faces ? [] : [`has ${links.length} font preloads, not ${faces}`]),
    ...links.flatMap((link) => [
      ...(/^\/_next\/static\/media\/[\w.-]+\.[a-z0-9_]{8,}\.woff2$/.test(link.href)
        ? []
        : [`preloads ${link.href}, which is not a hashed woff2 file of the export`]),
      ...(link.type === "font/woff2" ? [] : [`preloads ${link.href} without type font/woff2`]),
      ...(link.crossorigin ? [] : [`preloads ${link.href} without crossorigin`]),
    ]),
  ]
}

/** The `data:` URLs a page or stylesheet carries, which the content security policy forbids. */
export const dataUrls = (text: string): ReadonlyArray<string> =>
  text.match(/data:[a-z]+\/[a-z0-9.+-]+[;,]/gi) ?? []
