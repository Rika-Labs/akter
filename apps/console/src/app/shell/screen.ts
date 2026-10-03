import type { Children, Crumb } from "@akter/ui"
import { Option, Predicate } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Message } from "./message.ts"
import type { Model } from "./model.ts"
import type { PageData } from "./page.ts"

/**
 * What a page contributes to the frame: the document title, the top bar's crumbs and actions, and
 * the page body.
 */
export interface Screen {
  readonly title: string
  readonly crumbs: ReadonlyArray<Crumb>
  readonly actions?: Children
  readonly body: Html
}

/** What every page view receives: the builder, the whole Model, and its own page data. */
export interface ScreenInput<Page> {
  readonly h: HtmlBuilder<Message>
  readonly model: Model
  readonly page: Page
}

/** The page data when it is the kind `tag` names; stale data from the previous route is ignored. */
export const pageOf =
  <Tag extends PageData["_tag"]>(tag: Tag) =>
  (model: Model): Option.Option<Extract<PageData, { readonly _tag: Tag }>> =>
    Option.filter(model.page, (page): page is Extract<PageData, { readonly _tag: Tag }> =>
      Predicate.isTagged(page, tag),
    )
