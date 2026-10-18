"use client"

import { MarkdownCopyButton, ViewOptionsPopover } from "fumadocs-ui/layouts/notebook/page"

import { pageUrl } from "../content/page-markdown.ts"
import { repositoryLink } from "../content/site.ts"

/**
 * Copy the page as Markdown, or open it in an assistant or on GitHub. The Markdown is the
 * page's `.md` twin, fetched when the button is pressed.
 */
export function PageActions(props: { readonly slug: string; readonly sourcePath?: string }) {
  return (
    <div className="page-actions">
      <MarkdownCopyButton markdownUrl={`/${props.slug}.md`} />
      <ViewOptionsPopover
        markdownUrl={`/${props.slug}.md`}
        pageUrl={pageUrl(props.slug)}
        githubUrl={
          props.sourcePath === undefined
            ? undefined
            : repositoryLink({ path: props.sourcePath, directory: false })
        }
      />
    </div>
  )
}
