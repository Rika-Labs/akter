import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { accessibility } from "../design/accessibility.ts"
import { styleAttributes } from "../design/attributes.ts"
import type { ContentAttributes, SlotConfig } from "../design/contracts.ts"
import { entranceStyles, motionStyles } from "../design/motion.ts"
import {
  borders,
  colors,
  dimensions,
  layers,
  radius,
  shadows,
  space,
  typography,
} from "../tokens.stylex.ts"
import { icon, type IconName } from "./icon.ts"

const styles = stylex.create({
  anchor: { position: "relative", display: "inline-flex", minWidth: 0 },
  block: { display: "flex", width: "100%" },
  menu: {
    position: "fixed",
    inset: "auto",
    margin: 0,
    zIndex: layers.popover,
    minWidth: dimensions.menu,
    maxWidth: "min(20rem, calc(100vw - 1rem))",
    maxHeight: "min(26rem, calc(100dvh - 2rem))",
    overflowY: "auto",
    padding: space.xs,
    borderWidth: borders.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.popover,
    color: colors.foreground,
    boxShadow: shadows.popover,
    positionTryFallbacks: "flip-block, flip-inline",
  },
  below: { positionArea: "block-end span-inline-end", marginBlockStart: space.xs },
  belowEnd: { positionArea: "block-end span-inline-start", marginBlockStart: space.xs },
  above: { positionArea: "block-start span-inline-end", marginBlockEnd: space.xs },
  item: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    width: "100%",
    minHeight: "1.875rem",
    paddingInline: space.sm,
    borderRadius: radius.sm,
    color: colors.foreground,
    backgroundColor: {
      default: "transparent",
      ":hover": colors.accent,
      ":focus-visible": colors.accent,
    },
    fontSize: typography.body,
    textAlign: "start",
    textDecoration: "none",
    whiteSpace: "nowrap",
    cursor: "pointer",
    transitionProperty: "background-color",
  },
  itemIcon: { color: colors.mutedForeground, display: "inline-flex" },
  itemLabel: { flex: "1", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  detail: { color: colors.subtleForeground, fontSize: typography.caption },
  danger: { color: colors.destructive },
  check: { color: colors.foreground, display: "inline-flex" },
  separator: {
    height: "1px",
    marginBlock: space.xs,
    marginInline: `calc(-1 * ${space.xs})`,
    backgroundColor: colors.border,
  },
  heading: {
    paddingBlock: space.xs,
    paddingInline: space.sm,
    color: colors.subtleForeground,
    fontSize: typography.caption,
  },
})

const anchors = stylex.create({
  name: (name: string) => ({ anchorName: name }),
  target: (name: string) => ({ positionAnchor: name }),
})

/** A menu entry: an action or link, a divider, or a small heading over the entries below it. */
export type MenuEntry<Message> =
  | Readonly<{
      kind: "item"
      label: string
      icon?: IconName
      detail?: string
      href?: string
      onSelect?: Message
      tone?: "default" | "danger"
      checked?: boolean
    }>
  | Readonly<{ kind: "separator" }>
  | Readonly<{ kind: "heading"; label: string }>

/**
 * A menu anchored to its trigger. It uses the platform popover, so it opens in the top layer,
 * closes on Escape and outside clicks, and returns focus to the trigger. `trigger` receives the
 * attributes that wire a button to the menu and must spread them onto a `<button>`.
 */
export type DropdownMenuConfig<Message> = SlotConfig<Message> &
  Readonly<{
    id: string
    label: string
    entries: ReadonlyArray<MenuEntry<Message>>
    trigger: (attributes: ContentAttributes<Message>) => Html
    placement?: "below" | "below-end" | "above"
    block?: boolean
  }>

const placements = {
  below: styles.below,
  "below-end": styles.belowEnd,
  above: styles.above,
} as const

const render = <Message>(h: HtmlBuilder<Message>, config: DropdownMenuConfig<Message>): Html => {
  const anchorName = `--menu-${config.id}`
  const entry = (item: MenuEntry<Message>, index: number): Html => {
    if (item.kind === "separator")
      return h.div(
        [
          h.Role("separator"),
          h.Key(`separator-${String(index)}`),
          ...styleAttributes(h, styles.separator),
        ],
        [],
      )
    if (item.kind === "heading")
      return h.div(
        [h.Key(`heading-${item.label}`), ...styleAttributes(h, styles.heading)],
        [item.label],
      )
    const presentation = styleAttributes(
      h,
      styles.item,
      accessibility.focusInset,
      motionStyles.fast,
      item.tone === "danger" && styles.danger,
    )
    const children = [
      item.icon === undefined
        ? h.empty
        : h.span([...styleAttributes(h, styles.itemIcon)], [icon(h, { name: item.icon })]),
      h.span([...styleAttributes(h, styles.itemLabel)], [item.label]),
      item.detail === undefined
        ? h.empty
        : h.span([...styleAttributes(h, styles.detail)], [item.detail]),
      item.checked === true
        ? h.span([...styleAttributes(h, styles.check)], [icon(h, { name: "check", size: "small" })])
        : h.empty,
    ]
    if (item.href !== undefined)
      return h.a(
        [
          h.Key(`item-${item.label}`),
          h.Href(item.href),
          ...(item.checked === true ? [h.AriaCurrent("true")] : []),
          ...presentation,
        ],
        children,
      )
    return h.button(
      [
        h.Key(`item-${item.label}`),
        h.Type("button"),
        h.Popovertarget(config.id),
        h.Popovertargetaction("hide"),
        ...(item.checked === undefined ? [] : [h.AriaPressed(String(item.checked))]),
        ...(item.onSelect === undefined ? [] : [h.OnClick(item.onSelect)]),
        ...presentation,
      ],
      children,
    )
  }
  return h.div(
    [
      h.DataAttribute("slot", "dropdown-menu"),
      ...(config.attributes ?? []),
      ...styleAttributes(
        h,
        styles.anchor,
        config.block === true && styles.block,
        anchors.name(anchorName),
        config.style,
      ),
    ],
    [
      config.trigger([h.Popovertarget(config.id), h.AriaControls(config.id)]),
      h.div(
        [
          h.Id(config.id),
          h.Popover("auto"),
          h.AriaLabel(config.label),
          h.DataAttribute("slot", "menu"),
          ...styleAttributes(
            h,
            styles.menu,
            placements[config.placement ?? "below"],
            entranceStyles.rise,
            anchors.target(anchorName),
          ),
        ],
        config.entries.map(entry),
      ),
    ],
  )
}

/** A dropdown menu on the platform popover with anchor positioning. */
export const dropdownMenu: {
  <Message>(h: HtmlBuilder<Message>, config: DropdownMenuConfig<Message>): Html
  <Message>(config: DropdownMenuConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
