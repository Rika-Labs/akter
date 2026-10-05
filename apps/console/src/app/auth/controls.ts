import { accessibility, icon, type IconName, mark, styleAttributes } from "@akter/ui"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Message } from "../shell/message.ts"
import { authStyles as styles } from "./styles.ts"

type H = HtmlBuilder<Message>

/** A social sign-in row: its words and glyph, what clicking sends, and whether it is busy. */
export type ProviderButtonConfig = Readonly<{
  label: string
  icon: IconName
  onClick: Message
  disabled: boolean
}>

/** A white, square-cornered row that starts a social sign-in. */
export const providerButton: {
  (h: H, config: ProviderButtonConfig): Html
  (config: ProviderButtonConfig): (h: H) => Html
} = Function.dual(2, (h: H, config: ProviderButtonConfig): Html =>
  h.button(
    [
      h.Type("button"),
      h.Disabled(config.disabled),
      h.OnClick(config.onClick),
      ...styleAttributes(h, styles.provider, accessibility.focusRing),
    ],
    [icon(h, { name: config.icon }), config.label],
  ),
)

/** The mono "OR" rule between the social buttons and the form. */
export const divider = (h: H): Html =>
  h.div([h.AriaHidden(true), ...styleAttributes(h, styles.divider)], ["or"])

/** What a labelled input needs: its name and label, the current value, and how typing reports. */
export type TextFieldConfig = Readonly<{
  name: string
  label: string
  value: string
  type?: "text" | "email" | "password"
  placeholder?: string
  autocomplete: string
  description?: string
  trailing?: Html
  minlength?: number
  mono?: boolean
  autocapitalize?: "characters"
  onInput: (value: string) => Message
}>

/**
 * A labelled square input. `trailing` sits on the label's right, where "Forgot password?" goes, and
 * `description` is announced with the control.
 */
export const textField: {
  (h: H, config: TextFieldConfig): Html
  (config: TextFieldConfig): (h: H) => Html
} = Function.dual(2, (h: H, config: TextFieldConfig): Html =>
  h.div(
    [...styleAttributes(h, styles.field)],
    [
      h.div(
        [...styleAttributes(h, styles.fieldHead)],
        [
          h.label([h.For(config.name), ...styleAttributes(h, styles.label)], [config.label]),
          config.trailing ?? h.empty,
        ],
      ),
      h.input([
        h.Name(config.name),
        h.Id(config.name),
        h.Type(config.type ?? "text"),
        h.Value(config.value),
        ...(config.placeholder === undefined ? [] : [h.Placeholder(config.placeholder)]),
        h.Autocomplete(config.autocomplete),
        h.Required(true),
        h.AriaInvalid(false),
        h.Spellcheck(false),
        ...(config.description === undefined
          ? []
          : [h.AriaDescribedBy(`${config.name}-description`)]),
        ...(config.minlength === undefined ? [] : [h.Minlength(config.minlength)]),
        ...(config.autocapitalize === undefined ? [] : [h.Autocapitalize(config.autocapitalize)]),
        h.OnInput(config.onInput),
        ...styleAttributes(h, styles.input, config.mono === true && styles.mono),
      ]),
      config.description === undefined
        ? h.empty
        : h.p(
            [h.Id(`${config.name}-description`), ...styleAttributes(h, styles.hint)],
            [config.description],
          ),
    ],
  ),
)

/** What a button says and does; `mark` adds the Ak tile, `fit` sizes it to its label. */
export type ActionButtonConfig = Readonly<{
  label: string
  variant?: "primary" | "ghost"
  mark?: boolean
  fit?: boolean
  disabled?: boolean
  type?: "button" | "submit"
  onClick?: Message
  href?: string
}>

/**
 * The ink primary button or the hairline ghost one, mono and uppercase. `mark` adds the Ak tile at
 * its left, used on sign in and sign up; `fit` sizes it to its label instead of its row.
 */
export const actionButton: {
  (h: H, config: ActionButtonConfig): Html
  (config: ActionButtonConfig): (h: H) => Html
} = Function.dual(2, (h: H, config: ActionButtonConfig): Html => {
  const marked = config.mark === true
  const presentation = styleAttributes(
    h,
    styles.button,
    config.variant === "ghost" ? styles.ghost : styles.primary,
    config.fit === true && styles.fit,
    marked && styles.withMark,
    accessibility.focusRing,
  )
  const children: ReadonlyArray<Html> = [
    marked ? h.span([...styleAttributes(h, styles.markTile)], [mark(h, { size: 18 })]) : h.empty,
    h.span(
      [
        ...styleAttributes(
          h,
          config.fit !== true && styles.buttonLabel,
          marked && styles.buttonLabelMarked,
        ),
      ],
      [config.label],
    ),
  ]
  if (config.href !== undefined) return h.a([h.Href(config.href), ...presentation], children)
  return h.button(
    [
      h.Type(config.type ?? "button"),
      h.Disabled(config.disabled === true),
      ...(config.onClick === undefined ? [] : [h.OnClick(config.onClick)]),
      ...presentation,
    ],
    children,
  )
})
