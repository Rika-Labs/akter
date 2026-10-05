import { illustration, mark, styleAttributes } from "@akter/ui"
import { containerStrip } from "@akter/ui/brand"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Routes from "../navigation/routes.ts"
import type { Message } from "../shell/message.ts"
import { frameStyles as styles } from "./styles.ts"

type H = HtmlBuilder<Message>

/**
 * What a signed-out page puts around its column: `alt` is the switch on the top bar's right (a
 * question in muted text and the link that answers it), `wide` widens the column for onboarding,
 * and `busy` marks a page that is still opening.
 */
export type FrameConfig = Readonly<{
  alt?: Readonly<{ text: string; label: string; href: string }>
  wide?: boolean
  busy?: boolean
}>

/**
 * Every signed-out screen's page: the logo on the left of a borderless top bar, `alt` on the right,
 * one centred column for `children`, and the container strip along the bottom of the viewport.
 */
export const frame: {
  (h: H, config: FrameConfig, children: ReadonlyArray<Html>): Html
  (config: FrameConfig, children: ReadonlyArray<Html>): (h: H) => Html
} = Function.dual(3, (h: H, config: FrameConfig, children: ReadonlyArray<Html>): Html => {
  const alt = config.alt
  return h.div(
    [...styleAttributes(h, styles.page)],
    [
      h.header(
        [...styleAttributes(h, styles.bar)],
        [
          h.a(
            [h.Href(Routes.overview()), h.AriaLabel("Akter"), ...styleAttributes(h, styles.logo)],
            [mark(h, { size: 22 }), "akter"],
          ),
          alt === undefined
            ? h.empty
            : h.p(
                [...styleAttributes(h, styles.alt)],
                [
                  `${alt.text} `,
                  h.a([h.Href(alt.href), ...styleAttributes(h, styles.altLink)], [alt.label]),
                ],
              ),
        ],
      ),
      h.main(
        [
          h.Id("main"),
          ...(config.busy === true ? [h.AriaBusy(true)] : []),
          ...styleAttributes(h, styles.column, config.wide === true && styles.wide),
        ],
        children,
      ),
      h.footer(
        [h.AriaHidden(true), ...styleAttributes(h, styles.strip)],
        [
          h.div(
            [...styleAttributes(h, styles.stripArt)],
            [illustration(h, { drawing: containerStrip.drawing, viewBox: containerStrip.viewBox })],
          ),
        ],
      ),
    ],
  )
})
