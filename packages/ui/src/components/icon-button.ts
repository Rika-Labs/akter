import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { accessibility } from "../design/accessibility.ts"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { motionStyles } from "../design/motion.ts"
import { revealMarker } from "../markers.stylex.ts"
import { colors, dimensions, radius } from "../tokens.stylex.ts"
import { icon, type IconName } from "./icon.ts"
import { tooltipBubble, type TooltipSide } from "./tooltip.ts"

const styles = stylex.create({
  root: {
    position: "relative",
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    borderRadius: radius.sm,
    color: { default: colors.mutedForeground, ":hover": colors.foreground },
    backgroundColor: { default: "transparent", ":hover": colors.accent },
    cursor: "pointer",
    transitionProperty: "background-color, color",
  },
  pressed: { backgroundColor: colors.selected, color: colors.foreground },
  sm: { width: dimensions.controlSm, height: dimensions.controlSm },
  md: { width: dimensions.control, height: dimensions.control },
})

/** A square icon action. `label` is its accessible name and its tooltip. */
export type IconButtonConfig<Message> = SlotConfig<Message> &
  Readonly<{
    label: string
    icon: IconName
    size?: "sm" | "md"
    onClick?: Message
    href?: string
    pressed?: boolean
    tooltip?: TooltipSide | "none"
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: IconButtonConfig<Message>): Html => {
  const presentation = styleAttributes(
    h,
    styles.root,
    styles[config.size ?? "sm"],
    accessibility.focusRing,
    motionStyles.fast,
    revealMarker,
    config.pressed === true && styles.pressed,
    config.style,
  )
  const children = [
    icon(h, { name: config.icon }),
    config.tooltip === "none"
      ? h.empty
      : tooltipBubble(h, { label: config.label, side: config.tooltip ?? "bottom" }),
  ]
  const shared = [
    h.AriaLabel(config.label),
    h.DataAttribute("slot", "icon-button"),
    ...(config.attributes ?? []),
    ...presentation,
  ]
  if (config.href !== undefined) return h.a([h.Href(config.href), ...shared], children)
  return h.button(
    [
      h.Type("button"),
      ...(config.onClick === undefined ? [] : [h.OnClick(config.onClick)]),
      ...(config.pressed === undefined ? [] : [h.AriaPressed(String(config.pressed))]),
      ...shared,
    ],
    children,
  )
}

/** An icon-only button or link with a tooltip carrying its name. */
export const iconButton: {
  <Message>(h: HtmlBuilder<Message>, config: IconButtonConfig<Message>): Html
  <Message>(config: IconButtonConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
