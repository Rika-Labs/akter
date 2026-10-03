import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { accessibility } from "../design/accessibility.ts"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { motionStyles } from "../design/motion.ts"
import { borders, colors, radius, space, typography } from "../tokens.stylex.ts"
import { icon } from "./icon.ts"

const styles = stylex.create({
  label: {
    display: "inline-flex",
    alignItems: "flex-start",
    gap: space.sm,
    cursor: "pointer",
    fontSize: typography.small,
    color: colors.foreground,
  },
  box: {
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    width: "0.875rem",
    height: "0.875rem",
    marginBlockStart: "0.125rem",
    borderWidth: borders.hairline,
    borderStyle: "solid",
    borderColor: { default: colors.ring, ":hover": colors.foreground },
    borderRadius: radius.xs,
    backgroundColor: colors.card,
    color: colors.primaryForeground,
    cursor: "pointer",
    transitionProperty: "background-color, border-color",
  },
  checked: { backgroundColor: colors.primary, borderColor: colors.primary },
  copy: { display: "grid", gap: space.xxs },
  description: { color: colors.mutedForeground, fontSize: typography.caption },
})

/** A labelled checkbox; `description` adds one muted line under the label. */
export type CheckboxConfig<Message> = SlotConfig<Message> &
  Readonly<{
    checked: boolean
    label: string
    description?: string
    onToggle?: Message
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: CheckboxConfig<Message>): Html =>
  h.label(
    [h.DataAttribute("slot", "checkbox"), ...styleAttributes(h, styles.label, config.style)],
    [
      h.button(
        [
          h.Type("button"),
          h.Role("checkbox"),
          h.AriaChecked(config.checked),
          ...(config.onToggle === undefined ? [] : [h.OnClick(config.onToggle)]),
          ...(config.attributes ?? []),
          ...styleAttributes(
            h,
            styles.box,
            accessibility.focusRing,
            motionStyles.fast,
            config.checked && styles.checked,
          ),
        ],
        [config.checked ? icon(h, { name: "check", size: "small" }) : h.empty],
      ),
      h.span(
        [...styleAttributes(h, styles.copy)],
        [
          config.label,
          config.description === undefined
            ? h.empty
            : h.span([...styleAttributes(h, styles.description)], [config.description]),
        ],
      ),
    ],
  )

/** A checkbox whose label text is part of its click target. */
export const checkbox: {
  <Message>(h: HtmlBuilder<Message>, config: CheckboxConfig<Message>): Html
  <Message>(config: CheckboxConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
