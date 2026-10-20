"use client"

import { useState } from "react"

import { CheckGlyph, CopyGlyph } from "./glyphs.tsx"

/** The button in a code block's header that copies the block's text. */
export function CopyCodeButton() {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      className="ak-icon-btn"
      aria-label={copied ? "Copied" : "Copy code"}
      onClick={(event) => {
        const text = event.currentTarget.closest(".ak-code")?.querySelector("pre")?.textContent

        if (text === undefined || text === null) return

        void navigator.clipboard.writeText(text)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 2000)
      }}
    >
      {copied ? <CheckGlyph aria-hidden="true" /> : <CopyGlyph aria-hidden="true" />}
    </button>
  )
}
