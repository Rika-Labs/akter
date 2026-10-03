import * as stylex from "@stylexjs/stylex"
import type { Attribute, HtmlBuilder } from "foldkit/html"
import type { PartStyles } from "./contracts.ts"

type StyleAttribute = Extract<Attribute<never>, { _tag: "Class" | "Attribute" | "DataAttribute" }>

/**
 * The one FoldKit adapter for StyleX. FoldKit's class and inline-style attributes each have a single
 * owner, so an element resolves all of its styles in one call, after its primitive attributes.
 * Inline values come only from dynamic StyleX functions, which carry bounded data-derived geometry
 * such as a chart point's position.
 */
export const styleAttributes = <Message>(
  h: HtmlBuilder<Message>,
  ...styles: ReadonlyArray<PartStyles>
): ReadonlyArray<StyleAttribute> => {
  const resolved = stylex.props(...styles)
  const attributes: Array<StyleAttribute> = []
  if (resolved.className !== undefined) attributes.push(h.Class(resolved.className))
  if (resolved.style !== undefined) {
    const inline = Object.entries(resolved.style)
      .map(([key, value]) => `${key}:${String(value)}`)
      .join(";")
    attributes.push(h.Attribute("style", inline))
  }
  if (resolved["data-style-src"] !== undefined)
    attributes.push(h.DataAttribute("style-src", resolved["data-style-src"]))
  return attributes
}
