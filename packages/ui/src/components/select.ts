import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { motionStyles } from "../design/motion.ts"
import { colors, space } from "../tokens.stylex.ts"
import { icon } from "./icon.ts"
import { fieldChrome } from "./input.ts"

const styles = stylex.create({
  wrapper: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    minWidth: "7.5rem",
  },
  select: {
    appearance: "none",
    paddingInlineEnd: "1.75rem",
    cursor: "pointer",
  },
  chevron: {
    position: "absolute",
    insetInlineEnd: space.sm,
    color: colors.subtleForeground,
    pointerEvents: "none",
    display: "inline-flex",
  },
})

/** One choice in a select. */
export interface SelectOption {
  readonly value: string
  readonly label: string
}

/**
 * A native select: the platform's own picker on touch devices, full keyboard support, and a value
 * that forms submit without extra wiring.
 */
export type SelectConfig<Message> = SlotConfig<Message> &
  Readonly<{
    name: string
    value: string
    options: ReadonlyArray<SelectOption>
    label?: string
    id?: string
    size?: "sm" | "md" | "lg"
    disabled?: boolean
    onChange?: (value: string) => Message
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: SelectConfig<Message>): Html =>
  h.div(
    [...styleAttributes(h, styles.wrapper, config.style)],
    [
      h.select(
        [
          h.Name(config.name),
          h.Id(config.id ?? config.name),
          h.Value(config.value),
          h.Disabled(config.disabled === true),
          ...(config.label === undefined ? [] : [h.AriaLabel(config.label)]),
          ...(config.onChange === undefined ? [] : [h.OnChange(config.onChange)]),
          h.DataAttribute("slot", "select"),
          ...(config.attributes ?? []),
          ...styleAttributes(
            h,
            fieldChrome.box,
            fieldChrome[config.size ?? "sm"],
            styles.select,
            motionStyles.fast,
          ),
        ],
        config.options.map((option) =>
          h.option(
            [h.Value(option.value), h.Selected(option.value === config.value)],
            [option.label],
          ),
        ),
      ),
      h.span(
        [...styleAttributes(h, styles.chevron)],
        [icon(h, { name: "chevronUpDown", size: "small" })],
      ),
    ],
  )

/** A styled native select with a quiet chevron. */
export const select: {
  <Message>(h: HtmlBuilder<Message>, config: SelectConfig<Message>): Html
  <Message>(config: SelectConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
