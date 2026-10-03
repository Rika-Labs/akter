import { button, emptyState, illustration, pageBody, styleAttributes } from "@akter/ui"
import { adrift } from "@akter/ui/brand"
import * as stylex from "@stylexjs/stylex"
import { AppRoute } from "../navigation/routes.ts"
import * as Routes from "../navigation/routes.ts"
import { OpenedPalette } from "../shell/message.ts"
import type { Screen, ScreenInput } from "../shell/screen.ts"

const styles = stylex.create({ art: { width: "100%", maxWidth: "22rem", marginInline: "auto" } })

/** The page for an address that leads nowhere: a container adrift, and two ways back. */
export const notFoundScreen = ({ h, model }: ScreenInput<undefined>): Screen => ({
  title: "Not found",
  crumbs: [{ label: "Not found" }],
  body: pageBody(h, [
    emptyState(h, {
      title: "This page drifted off",
      description: `Nothing lives at ${AppRoute.isAnyOf(["NotFound"])(model.route) ? model.route.path : "this address"}. It may have been renamed, or it never shipped.`,
      illustration: h.div(
        [...styleAttributes(h, styles.art)],
        [illustration(h, { drawing: adrift.drawing, viewBox: adrift.viewBox })],
      ),
      actions: [
        button(h, { label: "Go to overview", variant: "primary", href: Routes.overview() }),
        button(h, { label: "Search", icon: "search", onClick: OpenedPalette() }),
      ],
    }),
  ]),
})
