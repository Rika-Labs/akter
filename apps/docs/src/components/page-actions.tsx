"use client"

import { ArrowUpRight, Check, Copy } from "lucide-react"
import { useState } from "react"

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
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
      <a className="ak-page-action" href={markdownPath} target="_blank" rel="noopener noreferrer">
        <span>View as Markdown</span>
        <ArrowUpRight aria-hidden="true" />
      </a>
    </div>
  )
}
