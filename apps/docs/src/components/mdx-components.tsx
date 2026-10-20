import type { MDXComponents } from "mdx/types"
import Link from "next/link"
import { isValidElement, type ComponentProps } from "react"

import { languageLabel, languageOf } from "../content/code-languages.ts"
import { Callout } from "./callout.tsx"
import { CopyCodeButton } from "./copy-code-button.tsx"
import { H2, H3, H4 } from "./headings.tsx"

function Anchor({ href, ...rest }: ComponentProps<"a">) {
  return href?.startsWith("/") === true ? (
    <Link href={href} {...rest} />
  ) : (
    <a href={href} {...rest} />
  )
}

function CodeBlock(props: ComponentProps<"pre">) {
  const code = isValidElement<{ className?: string }>(props.children) ? props.children : undefined

  return (
    <div className="ak-code" data-code="true">
      <div className="ak-code-head">
        <span className="ak-code-lang">{languageLabel(languageOf(code?.props.className))}</span>
        <CopyCodeButton />
      </div>
      <pre {...props} />
    </div>
  )
}

/**
 * The elements pages are written with. `callout` is the node the `<Warning>` rewrite
 * emits; headings carry their anchors, code its header, and a table scrolls sideways on
 * a narrow screen instead of widening the page.
 */
export const mdxComponents: MDXComponents = {
  a: Anchor,
  callout: Callout,
  h2: H2,
  h3: H3,
  h4: H4,
  pre: CodeBlock,
  table: (props: ComponentProps<"table">) => (
    <div className="ak-table">
      <table {...props} />
    </div>
  ),
}
