import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { accessibility } from "../design/accessibility.ts"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { motionStyles } from "../design/motion.ts"
import { borders, colors, dimensions, radius, space, typography } from "../tokens.stylex.ts"
import { icon, type IconName } from "./icon.ts"

/** Emphasis, from the one primary action on a surface down to a quiet text action. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link"

/** Control heights: `sm` for top bars and rows, `md` for forms, `lg` for sign-in screens. */
export type ButtonSize = "sm" | "md" | "lg"

const styles = stylex.create({
  base: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: space.s,
    borderRadius: radius.sm,
    borderWidth: borders.hairline,
    borderStyle: "solid",
    borderColor: "transparent",
    fontFamily: "inherit",
    fontSize: typography.small,
    fontWeight: typography.weightMedium,
    lineHeight: 1,
    whiteSpace: "nowrap",
    textDecoration: "none",
    cursor: { default: "pointer", ":disabled": "default" },
    userSelect: "none",
    opacity: { default: 1, ":disabled": 0.45, ":is([aria-disabled='true'])": 0.45 },
    transitionProperty: "background-color, border-color, color, box-shadow",
  },
  primary: {
    backgroundColor: { default: colors.primary, ":hover:not(:disabled)": colors.primaryHover },
    borderColor: colors.primary,
    color: colors.primaryForeground,
  },
  secondary: {
    backgroundColor: { default: colors.card, ":hover:not(:disabled)": colors.muted },
    borderColor: colors.borderStrong,
    color: colors.foreground,
  },
  ghost: {
    backgroundColor: { default: "transparent", ":hover:not(:disabled)": colors.accent },
    color: { default: colors.mutedForeground, ":hover:not(:disabled)": colors.foreground },
  },
  danger: {
    backgroundColor: colors.destructive,
    borderColor: colors.destructive,
    color: colors.primaryForeground,
    opacity: { default: 1, ":hover:not(:disabled)": 0.9, ":disabled": 0.45 },
  },
  link: {
    height: "auto",
    paddingInline: 0,
    color: { default: colors.mutedForeground, ":hover": colors.foreground },
    textDecorationLine: { default: "none", ":hover": "underline" },
    textUnderlineOffset: space.xs,
  },
  sm: { height: dimensions.controlSm, paddingInline: "0.625rem" },
  md: { height: dimensions.control, paddingInline: space.md },
  lg: { height: dimensions.controlLg, paddingInline: space.lg, fontSize: typography.body },
  iconOnlySm: { width: dimensions.controlSm, paddingInline: 0 },
  iconOnlyMd: { width: dimensions.control, paddingInline: 0 },
  iconOnlyLg: { width: dimensions.controlLg, paddingInline: 0 },
  trailing: { marginInlineStart: space.xxs, color: colors.subtleForeground },
  label: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
})

/**
 * The visual treatment shared by real buttons and link-styled actions, for compositions that render
 * their own element (a dropdown trigger, a row action).
 */
export const buttonStyles = (look: ButtonLook) => [
  styles.base,
  accessibility.focusRing,
  motionStyles.fast,
  styles[look.variant],
  look.variant !== "link" && styles[look.size],
]

/** A variant and size pair. */
export type ButtonLook = Readonly<{ variant: ButtonVariant; size: ButtonSize }>

/** A button or a link that looks like one. `href` renders a link; otherwise `onClick` fires. */
export type ButtonConfig<Message> = SlotConfig<Message> &
  Readonly<{
    label: string
    variant?: ButtonVariant
    size?: ButtonSize
    icon?: IconName
    trailingIcon?: IconName
    iconOnly?: boolean
    href?: string
    external?: boolean
    onClick?: Message
    type?: "button" | "submit" | "reset"
    disabled?: boolean
  }>

const iconOnlyStyles = {
  sm: styles.iconOnlySm,
  md: styles.iconOnlyMd,
  lg: styles.iconOnlyLg,
} as const

const render = <Message>(h: HtmlBuilder<Message>, config: ButtonConfig<Message>): Html => {
  const variant = config.variant ?? "secondary"
  const size = config.size ?? "md"
  const iconOnly = config.iconOnly === true
  const children = [
    config.icon === undefined ? h.empty : icon(h, { name: config.icon }),
    iconOnly ? h.empty : h.span([...styleAttributes(h, styles.label)], [config.label]),
    config.trailingIcon === undefined
      ? h.empty
      : h.span(
          [...styleAttributes(h, styles.trailing)],
          [icon(h, { name: config.trailingIcon, size: "small" })],
        ),
  ]
  const presentation = styleAttributes(
    h,
    buttonStyles({ variant, size }),
    iconOnly && iconOnlyStyles[size],
    config.style,
  )
  const label = iconOnly ? [h.AriaLabel(config.label)] : []
  if (config.href !== undefined) {
    const external =
      config.external === true ? [h.Target("_blank"), h.Rel("noopener noreferrer")] : []
    return h.a(
      [
        h.Href(config.href),
        ...external,
        ...label,
        h.DataAttribute("slot", "button"),
        ...(config.attributes ?? []),
        ...presentation,
      ],
      children,
    )
  }
  return h.button(
    [
      h.Type(config.type ?? "button"),
      h.Disabled(config.disabled === true),
      ...(config.onClick === undefined ? [] : [h.OnClick(config.onClick)]),
      ...label,
      h.DataAttribute("slot", "button"),
      ...(config.attributes ?? []),
      ...presentation,
    ],
    children,
  )
}

/** A button with an optional leading icon; `iconOnly` keeps the label for assistive technology. */
export const button: {
  <Message>(h: HtmlBuilder<Message>, config: ButtonConfig<Message>): Html
  <Message>(config: ButtonConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
