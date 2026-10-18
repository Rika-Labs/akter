"use client"

import { Check, Copy } from "lucide-react"
import { useState } from "react"

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
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </button>
  )
}
