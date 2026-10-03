import { button, emptyState, pageBody } from "@akter/ui"
import type { HtmlBuilder } from "foldkit/html"
import * as Routes from "../navigation/routes.ts"
import { type Message, RetriedPage } from "./message.ts"
import type { PageError } from "./model.ts"
import type { Screen } from "./screen.ts"

/** What a page shows when its data could not load: the reason, and a way to try again. */
export const failureScreen = ({
  h,
  error,
}: Readonly<{ h: HtmlBuilder<Message>; error: PageError }>): Screen => ({
  title: "Couldn’t load this page",
  crumbs: [{ label: "Couldn’t load" }],
  body: pageBody(h, [
    emptyState(h, {
      title: "This page couldn’t load",
      description: error.message,
      actions: [
        button(h, { label: "Try again", variant: "primary", onClick: RetriedPage() }),
        button(h, { label: "Go to overview", href: Routes.overview() }),
      ],
    }),
  ]),
})
