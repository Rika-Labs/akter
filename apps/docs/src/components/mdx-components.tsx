import { Callout } from "fumadocs-ui/components/callout"
import defaultMdxComponents from "fumadocs-ui/mdx"
import type { MDXComponents } from "mdx/types"
import type { ComponentProps } from "react"

type CalloutType = ComponentProps<typeof Callout>["type"]

/**
 * The elements pages can use. `callout` is the node the `<Warning>` rewrite emits;
 * everything else is the default Fumadocs set.
 */
export const mdxComponents: MDXComponents = {
  ...defaultMdxComponents,
  callout: ({ type, children }: { type?: CalloutType; children?: React.ReactNode }) => (
    <Callout type={type}>{children}</Callout>
  ),
}
