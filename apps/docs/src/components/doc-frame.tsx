import type { ReactNode } from "react"

import type { TocItem } from "../content/toc-items.ts"
import { PageActions } from "./page-actions.tsx"
import { Toc } from "./toc.tsx"

/**
 * The frame every article sits in: the title, the prose, and at the right the table of
 * contents with the two page actions, which move under the article when the panel is narrow.
 */
export function DocFrame(props: {
  readonly title: string
  readonly slug: string
  readonly toc: ReadonlyArray<TocItem>
  readonly children: ReactNode
}) {
  return (
    <div className="ak-page-grid">
      <article className="ak-page" data-kind="doc">
        <header className="ak-head">
          <h1 className="ak-title">{props.title}</h1>
        </header>
        <div className="ak-prose">{props.children}</div>
        <div className="ak-page-actions-mobile">
          <PageActions slug={props.slug} />
        </div>
      </article>
      <aside className="ak-toc-col">
        <div className="ak-page-rail">
          <Toc items={props.toc} />
          <PageActions slug={props.slug} />
        </div>
      </aside>
    </div>
  )
}
