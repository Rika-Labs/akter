import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { colors, space, typography } from "../tokens.stylex.ts"

const styles = stylex.create({
  root: { display: "grid", gap: space.s, minWidth: 0 },
  head: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.md,
  },
  label: {
    fontSize: typography.small,
    fontWeight: typography.weightMedium,
    color: colors.foreground,
  },
  description: { fontSize: typography.caption, color: colors.mutedForeground },
  error: { fontSize: typography.caption, color: colors.destructive },
})

/**
 * A label above one control, with an optional description and error. `id` must match the
 * control's id so the label and the messages are announced with it.
 */
export type FieldConfig<Message> = SlotConfig<Message> &
  Readonly<{
    id: string
    label: string
    control: Html
    description?: string
    error?: string
    trailing?: Html
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: FieldConfig<Message>): Html =>
  h.div(
    [
      h.DataAttribute("slot", "field"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.root, config.style),
    ],
    [
      h.div(
        [...styleAttributes(h, styles.head)],
        [
          h.label([h.For(config.id), ...styleAttributes(h, styles.label)], [config.label]),
          config.trailing ?? h.empty,
        ],
      ),
      config.control,
      config.description === undefined
        ? h.empty
        : h.p(
            [h.Id(`${config.id}-description`), ...styleAttributes(h, styles.description)],
            [config.description],
          ),
      config.error === undefined
        ? h.empty
        : h.p(
            [h.Id(`${config.id}-error`), h.Role("alert"), ...styleAttributes(h, styles.error)],
            [config.error],
          ),
    ],
  )

/** A labelled form row. Pass `describedBy: fieldDescriptionId(id)` to the control it wraps. */
export const field: {
  <Message>(h: HtmlBuilder<Message>, config: FieldConfig<Message>): Html
  <Message>(config: FieldConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)

/** The id `field` gives its description line, for the control's `aria-describedby`. */
export const fieldDescriptionId = (id: string): string => `${id}-description`
