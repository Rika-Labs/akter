import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { LayoutStyles } from "../design/contracts.ts"
import { motionStyles } from "../design/motion.ts"
import { space, typography } from "../tokens.stylex.ts"
import { fieldChrome } from "./input.ts"

const styles = stylex.create({
  root: {
    minHeight: "5.5rem",
    paddingBlock: space.sm,
    paddingInline: "0.625rem",
    lineHeight: typography.leadingNormal,
    resize: "vertical",
  },
})

/** A multi-line text input. Text areas take their value as a property, never inner HTML. */
export type TextareaConfig<Message> = Readonly<{ style?: LayoutStyles }> &
  Readonly<{
    name: string
    value: string
    id?: string
    label?: string
    placeholder?: string
    rows?: number
    mono?: boolean
    invalid?: boolean
    describedBy?: string
    onInput?: (value: string) => Message
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: TextareaConfig<Message>): Html =>
  h.textarea([
    h.Name(config.name),
    h.Id(config.id ?? config.name),
    h.Value(config.value),
    h.Rows(config.rows ?? 4),
    ...(config.placeholder === undefined ? [] : [h.Placeholder(config.placeholder)]),
    ...(config.label === undefined ? [] : [h.AriaLabel(config.label)]),
    ...(config.describedBy === undefined ? [] : [h.AriaDescribedBy(config.describedBy)]),
    h.AriaInvalid(config.invalid === true),
    h.Spellcheck(config.mono !== true),
    ...(config.onInput === undefined ? [] : [h.OnInput(config.onInput)]),
    h.DataAttribute("slot", "textarea"),
    ...styleAttributes(
      h,
      fieldChrome.box,
      styles.root,
      motionStyles.fast,
      config.mono === true && fieldChrome.mono,
      config.style,
    ),
  ])

/** A text area sharing the input's chrome; `mono` suits pasted `.env` files and JSON. */
export const textarea: {
  <Message>(h: HtmlBuilder<Message>, config: TextareaConfig<Message>): Html
  <Message>(config: TextareaConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
