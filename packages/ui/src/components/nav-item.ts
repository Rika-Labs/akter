import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { accessibility } from "../design/accessibility.ts"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { motionStyles } from "../design/motion.ts"
import { colors, dimensions, radius, space, typography } from "../tokens.stylex.ts"
import { icon, type IconName } from "./icon.ts"
import { statusDot } from "./status.ts"

const styles = stylex.create({
  item: {
    display: "flex",
    alignItems: "center",
    gap: "0.5625rem",
    minWidth: 0,
    height: dimensions.navItem,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    color: { default: colors.mutedForeground, ":hover": colors.foreground },
    backgroundColor: { default: "transparent", ":hover": colors.accent },
    fontSize: typography.body,
    fontWeight: 460,
    textDecoration: "none",
    whiteSpace: "nowrap",
    transitionProperty: "background-color, color",
  },
  active: {
    color: colors.foreground,
    backgroundColor: { default: colors.selected, ":hover": colors.selected },
  },
  label: { minWidth: 0, flex: "1", overflow: "hidden", textOverflow: "ellipsis" },
  count: {
    marginInlineStart: "auto",
    color: colors.subtleForeground,
    fontSize: typography.caption,
    fontVariantNumeric: "tabular-nums",
  },
  alert: { color: colors.foreground, fontWeight: typography.weightMedium },
  pinned: {
    height: dimensions.pinnedItem,
    fontFamily: typography.mono,
    fontSize: typography.caption,
    fontWeight: 400,
  },
  time: {
    marginInlineStart: "auto",
    flexShrink: 0,
    paddingInlineStart: space.sm,
    fontFamily: typography.sans,
    fontSize: typography.micro,
    color: colors.subtleForeground,
  },
})

/** A navigation link with an icon, an optional count, and an active state. */
export type NavItemConfig<Message> = SlotConfig<Message> &
  Readonly<{
    label: string
    href: string
    icon: IconName
    active?: boolean
    count?: string
    countTone?: "quiet" | "alert"
  }>

const renderNavItem = <Message>(h: HtmlBuilder<Message>, config: NavItemConfig<Message>): Html =>
  h.a(
    [
      h.Href(config.href),
      ...(config.active === true ? [h.AriaCurrent("page")] : []),
      h.DataAttribute("slot", "nav-item"),
      ...(config.attributes ?? []),
      ...styleAttributes(
        h,
        styles.item,
        accessibility.focusInset,
        motionStyles.fast,
        config.active === true && styles.active,
        config.style,
      ),
    ],
    [
      icon(h, { name: config.icon }),
      h.span([...styleAttributes(h, styles.label)], [config.label]),
      config.count === undefined
        ? h.empty
        : h.span(
            [
              ...(config.countTone === "alert"
                ? [h.AriaLabel(`${config.count} need attention`)]
                : []),
              ...styleAttributes(h, styles.count, config.countTone === "alert" && styles.alert),
            ],
            [config.count],
          ),
    ],
  )

/** A primary navigation item. */
export const navItem: {
  <Message>(h: HtmlBuilder<Message>, config: NavItemConfig<Message>): Html
  <Message>(config: NavItemConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, renderNavItem)

/** A pinned actor: its address, whether it is awake, and when it last ran a turn. */
export type PinnedItemConfig<Message> = SlotConfig<Message> &
  Readonly<{
    address: string
    href: string
    awake: boolean
    time: string
    active?: boolean
  }>

const renderPinnedItem = <Message>(
  h: HtmlBuilder<Message>,
  config: PinnedItemConfig<Message>,
): Html =>
  h.a(
    [
      h.Href(config.href),
      h.Title(`${config.address} · ${config.awake ? "awake" : "asleep"} · ${config.time}`),
      ...(config.active === true ? [h.AriaCurrent("page")] : []),
      h.DataAttribute("slot", "pinned-item"),
      ...(config.attributes ?? []),
      ...styleAttributes(
        h,
        styles.item,
        styles.pinned,
        accessibility.focusInset,
        motionStyles.fast,
        config.active === true && styles.active,
        config.style,
      ),
    ],
    [
      statusDot(h, config.awake ? "live" : "idle"),
      h.span([...styleAttributes(h, styles.label)], [config.address]),
      h.span([...styleAttributes(h, styles.time)], [config.time]),
    ],
  )

/** A pinned actor shortcut in the sidebar. */
export const pinnedItem: {
  <Message>(h: HtmlBuilder<Message>, config: PinnedItemConfig<Message>): Html
  <Message>(config: PinnedItemConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, renderPinnedItem)
