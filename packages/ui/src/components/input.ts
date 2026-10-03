import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { motionStyles } from "../design/motion.ts"
import { borders, colors, dimensions, radius, space, typography } from "../tokens.stylex.ts"
import { icon, type IconName } from "./icon.ts"

/**
 * Shared field chrome for text inputs, text areas and selects: a hairline box on the card surface
 * that darkens its border on hover and draws the focus ring on keyboard and pointer focus alike,
 * because a focused text field always needs to show where typing lands.
 */
export const fieldChrome = stylex.create({
  box: {
    width: "100%",
    minWidth: 0,
    borderWidth: borders.hairline,
    borderStyle: "solid",
    borderColor: {
      default: colors.borderStrong,
      ":hover": colors.ring,
      ":focus": colors.ring,
      ":is([aria-invalid='true'])": colors.destructive,
    },
    borderRadius: radius.sm,
    backgroundColor: colors.card,
    color: colors.foreground,
    fontFamily: "inherit",
    fontSize: typography.small,
    outlineStyle: "solid",
    outlineWidth: { default: 0, ":focus": borders.focus, ":focus-visible": borders.focus },
    outlineColor: colors.accent,
    outlineOffset: 0,
    transitionProperty: "border-color, outline-width",
    opacity: { default: 1, ":disabled": 0.5 },
  },
  sm: { height: dimensions.controlSm, paddingInline: space.sm },
  md: { height: dimensions.control, paddingInline: "0.625rem" },
  lg: { height: dimensions.controlLg, paddingInline: space.md, fontSize: typography.body },
  mono: { fontFamily: typography.mono, fontSize: typography.caption },
})

const styles = stylex.create({
  wrapper: { position: "relative", display: "flex", alignItems: "center", minWidth: 0 },
  leading: {
    position: "absolute",
    insetInlineStart: "0.625rem",
    color: colors.subtleForeground,
    pointerEvents: "none",
    display: "inline-flex",
  },
  withLeading: { paddingInlineStart: "2rem" },
  trailing: {
    position: "absolute",
    insetInlineEnd: space.s,
    display: "inline-flex",
    alignItems: "center",
  },
  withTrailing: { paddingInlineEnd: "3rem" },
})

/** A single-line text input. `onInput` receives the new value on every keystroke. */
export type InputConfig<Message> = SlotConfig<Message> &
  Readonly<{
    name: string
    value: string
    label?: string
    id?: string
    type?: "text" | "email" | "password" | "search" | "url" | "number"
    placeholder?: string
    autocomplete?: string
    size?: "sm" | "md" | "lg"
    icon?: IconName
    trailing?: Html
    mono?: boolean
    invalid?: boolean
    required?: boolean
    readonly?: boolean
    disabled?: boolean
    describedBy?: string
    onInput?: (value: string) => Message
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: InputConfig<Message>): Html => {
  const field = h.input([
    h.Name(config.name),
    h.Id(config.id ?? config.name),
    h.Type(config.type ?? "text"),
    h.Value(config.value),
    ...(config.placeholder === undefined ? [] : [h.Placeholder(config.placeholder)]),
    ...(config.label === undefined ? [] : [h.AriaLabel(config.label)]),
    ...(config.describedBy === undefined ? [] : [h.AriaDescribedBy(config.describedBy)]),
    h.Autocomplete(config.autocomplete ?? "off"),
    h.Required(config.required === true),
    h.Readonly(config.readonly === true),
    h.Disabled(config.disabled === true),
    h.AriaInvalid(config.invalid === true),
    h.Spellcheck(false),
    ...(config.onInput === undefined ? [] : [h.OnInput(config.onInput)]),
    h.DataAttribute("slot", "input"),
    ...(config.attributes ?? []),
    ...styleAttributes(
      h,
      fieldChrome.box,
      fieldChrome[config.size ?? "md"],
      motionStyles.fast,
      config.mono === true && fieldChrome.mono,
      config.icon !== undefined && styles.withLeading,
      config.trailing !== undefined && styles.withTrailing,
      config.icon === undefined && config.trailing === undefined && config.style,
    ),
  ])
  if (config.icon === undefined && config.trailing === undefined) return field
  return h.div(
    [...styleAttributes(h, styles.wrapper, config.style)],
    [
      config.icon === undefined
        ? h.empty
        : h.span([...styleAttributes(h, styles.leading)], [icon(h, { name: config.icon })]),
      field,
      config.trailing === undefined
        ? h.empty
        : h.span([...styleAttributes(h, styles.trailing)], [config.trailing]),
    ],
  )
}

/** A text input with optional leading icon and trailing slot (a shortcut hint, a reveal toggle). */
export const input: {
  <Message>(h: HtmlBuilder<Message>, config: InputConfig<Message>): Html
  <Message>(config: InputConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
