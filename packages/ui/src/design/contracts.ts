import type { CompiledStyles, InlineStyles, StaticStyles, StyleXArray } from "@stylexjs/stylex"
import type { Attribute, ChildAttribute, Html } from "foldkit/html"
import type { dimensions, space } from "../tokens.stylex.ts"

type Spacing = typeof space.sm | 0 | "auto"
type Dimension = typeof dimensions.control | "auto" | "100%" | "fit-content" | "min-content" | 0
type Alignment =
  | "auto"
  | "normal"
  | "stretch"
  | "center"
  | "start"
  | "end"
  | "flex-start"
  | "flex-end"
  | "baseline"

/**
 * What a parent may say about a component it places: where it sits and how much room it takes. It
 * cannot replace colour, padding, type or focus treatment; a different presentation is a variant.
 */
export type LayoutStyles = StaticStyles<{
  display?: "none" | "block" | "inline" | "inline-block" | "flex" | "inline-flex" | "grid"
  flex?: string | number
  flexGrow?: number
  flexShrink?: number
  flexBasis?: Dimension
  alignSelf?: Alignment
  justifySelf?: Alignment
  order?: number
  width?: Dimension
  minWidth?: Dimension
  maxWidth?: Dimension | "none"
  height?: Dimension
  minHeight?: Dimension
  inlineSize?: Dimension
  margin?: Spacing
  marginTop?: Spacing
  marginBottom?: Spacing
  marginInline?: Spacing
  marginBlock?: Spacing
  marginInlineStart?: Spacing
  marginInlineEnd?: Spacing
  gridColumn?: string | number
  gridRow?: string | number
}>

/** Non-style attributes a caller may add to a component's root: ids, ARIA, data and handlers. */
export type ContentAttributes<Message> = ReadonlyArray<
  Exclude<Attribute<Message>, { _tag: "Class" | "Style" }> | ChildAttribute
>

/** The two caller-controlled slots every component accepts on its root element. */
export type SlotConfig<Message> = Readonly<{
  style?: LayoutStyles
  attributes?: ContentAttributes<Message>
}>

/** Element children: rendered nodes or text. */
export type Children = ReadonlyArray<Html | string>

/**
 * One argument accepted by `stylex.props`: compiled static styles, a compiled dynamic style tuple,
 * a falsy conditional, or a nested array of those. Mirrors StyleX's own declaration because
 * `Parameters<typeof stylex.props>` collapses under this project's TypeScript.
 */
export type PartStyles = StyleXArray<
  CompiledStyles | Readonly<[CompiledStyles, InlineStyles]> | boolean | null | undefined
>
