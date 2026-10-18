"use client"

import { MarkdownCopyButton, ViewOptionsPopover } from "fumadocs-ui/layouts/notebook/page"

import { repositoryLink } from "../content/site.ts"

/**
 * Copy the page as Markdown, or open it in an assistant or on GitHub. The Markdown is the
 * page's `.md` twin, fetched from the page's own origin when the button is pressed. The
 * public addresses that the popover links to and hands to an assistant arrive as props
 * because the build origin is only known to the server render.
 */
export function PageActions(props: {
  readonly slug: string
  readonly pageUrl: string
  readonly markdownUrl: string
  readonly sourcePath?: string
}) {
  return (
    <div className="page-actions">
      <MarkdownCopyButton markdownUrl={`/${props.slug}.md`} />
      <ViewOptionsPopover
        markdownUrl={props.markdownUrl}
        pageUrl={props.pageUrl}
        githubUrl={
          props.sourcePath === undefined
            ? undefined
            : repositoryLink({ path: props.sourcePath, directory: false })
        }
      />
    </div>
  )
}
