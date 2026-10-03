import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { accessibility } from "../design/accessibility.ts"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { motionStyles } from "../design/motion.ts"
import { colors, dimensions, radius, shadows } from "../tokens.stylex.ts"

const styles = stylex.create({
  track: {
    position: "relative",
    display: "inline-flex",
    flexShrink: 0,
    width: dimensions.switchWidth,
    height: dimensions.switchHeight,
    borderRadius: radius.full,
    backgroundColor: colors.borderStrong,
    cursor: { default: "pointer", ":disabled": "default" },
    opacity: { default: 1, ":disabled": 0.45 },
    transitionProperty: "background-color",
  },
  on: { backgroundColor: colors.primary },
  thumb: {
    position: "absolute",
    insetBlockStart: "2px",
    insetInlineStart: "2px",
    width: "0.75rem",
    height: "0.75rem",
    borderRadius: radius.full,
    backgroundColor: colors.card,
    boxShadow: shadows.sm,
    transitionProperty: "translate",
  },
  thumbOn: { translate: "0.75rem 0", backgroundColor: colors.primaryForeground },
})

/** An on/off control. `label` names it for assistive technology when no visible label is linked. */
export type SwitchConfig<Message> = SlotConfig<Message> &
  Readonly<{
    checked: boolean
    label: string
    id?: string
    disabled?: boolean
    onToggle?: Message
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: SwitchConfig<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.Role("switch"),
      h.AriaChecked(config.checked),
      h.AriaLabel(config.label),
      ...(config.id === undefined ? [] : [h.Id(config.id)]),
      h.Disabled(config.disabled === true),
      ...(config.onToggle === undefined ? [] : [h.OnClick(config.onToggle)]),
      h.DataAttribute("slot", "switch"),
      ...(config.attributes ?? []),
      ...styleAttributes(
        h,
        styles.track,
        accessibility.focusRing,
        motionStyles.moderate,
        config.checked && styles.on,
        config.style,
      ),
    ],
    [
      h.span(
        [
          ...styleAttributes(
            h,
            styles.thumb,
            motionStyles.moderate,
            config.checked && styles.thumbOn,
          ),
        ],
        [],
      ),
    ],
  )

/** A switch for settings that take effect immediately. */
export const switchControl: {
  <Message>(h: HtmlBuilder<Message>, config: SwitchConfig<Message>): Html
  <Message>(config: SwitchConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
