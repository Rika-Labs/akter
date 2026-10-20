"use client"

import { useState } from "react"

import { CheckGlyph, CopyGlyph, ExternalGlyph } from "./glyphs.tsx"

/**
 * The two actions under a page's table of contents: copy the page as Markdown, and open the
 * Markdown itself. The Markdown is the page's `.md` twin, fetched from the page's own origin
 * when the button is pressed.
 */
export function PageActions(props: { readonly slug: string }) {
  const [copied, setCopied] = useState(false)
  const markdownPath = `/${props.slug}.md`

  const copy = async () => {
    const response = await fetch(markdownPath)

    await navigator.clipboard.writeText(await response.text())
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="ak-page-actions">
      <button type="button" className="ak-page-action" onClick={() => void copy()}>
        <span aria-live="polite">{copied ? "Copied" : "Copy page"}</span>
        {copied ? <CheckGlyph aria-hidden="true" /> : <CopyGlyph aria-hidden="true" />}
      </button>
      <a className="ak-page-action" href={markdownPath} target="_blank" rel="noopener noreferrer">
        <span>View as Markdown</span>
        <ExternalGlyph aria-hidden="true" />
      </a>
    </div>
  )
}
