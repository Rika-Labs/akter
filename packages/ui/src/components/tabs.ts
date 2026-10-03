import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { accessibility } from "../design/accessibility.ts"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { motionStyles } from "../design/motion.ts"
import { borders, colors, radius, space, typography } from "../tokens.stylex.ts"

const styles = stylex.create({
  underline: {
    display: "flex",
    gap: space.xl,
    overflowX: "auto",
    scrollbarWidth: "none",
    borderBottomWidth: borders.hairline,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
  segmented: {
    display: "inline-flex",
    gap: space.xxs,
    padding: space.xxs,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  tab: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s,
    flexShrink: 0,
    color: { default: colors.mutedForeground, ":hover": colors.foreground },
    fontSize: typography.body,
    whiteSpace: "nowrap",
    textDecoration: "none",
    cursor: "pointer",
    transitionProperty: "color, box-shadow, background-color",
  },
  underlineTab: {
    paddingBlockEnd: "0.625rem",
    boxShadow: "inset 0 0 0 transparent",
  },
  underlineActive: {
    color: colors.foreground,
    boxShadow: `inset 0 -${borders.strong} 0 ${colors.foreground}`,
  },
  segmentedTab: {
    height: "1.5rem",
    paddingInline: space.md,
    borderRadius: radius.xs,
    fontSize: typography.small,
  },
  segmentedActive: {
    color: colors.foreground,
    backgroundColor: colors.card,
    boxShadow: `0 0 0 ${borders.hairline} ${colors.border}`,
  },
  count: {
    color: colors.subtleForeground,
    fontSize: typography.caption,
    fontVariantNumeric: "tabular-nums",
  },
})

/** One tab: a link when it changes the URL, a button when it changes local state. */
export interface TabItem<Message> {
  readonly id: string
  readonly label: string
  readonly count?: string
  readonly href?: string
  readonly onSelect?: Message
}

/**
 * A row of tabs. Link tabs render as a navigation list marked with `aria-current`; button tabs
 * render as a tab list whose selected tab controls `panelId`.
 */
export type TabsConfig<Message> = SlotConfig<Message> &
  Readonly<{
    label: string
    items: ReadonlyArray<TabItem<Message>>
    selected: string
    variant?: "underline" | "segmented"
    panelId?: string
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: TabsConfig<Message>): Html => {
  const segmented = config.variant === "segmented"
  const asLinks = config.items.every((item) => item.href !== undefined)
  const tab = (item: TabItem<Message>) => {
    const active = item.id === config.selected
    const presentation = styleAttributes(
      h,
      styles.tab,
      accessibility.focusRing,
      motionStyles.fast,
      segmented ? styles.segmentedTab : styles.underlineTab,
      active && (segmented ? styles.segmentedActive : styles.underlineActive),
    )
    const children = [
      item.label,
      item.count === undefined
        ? h.empty
        : h.span([...styleAttributes(h, styles.count)], [item.count]),
    ]
    if (item.href !== undefined)
      return h.a(
        [
          h.Href(item.href),
          ...(active ? [h.AriaCurrent("page")] : []),
          h.DataAttribute("tab", item.id),
          ...presentation,
        ],
        children,
      )
    return h.button(
      [
        h.Type("button"),
        h.Role("tab"),
        h.Id(`tab-${item.id}`),
        h.AriaSelected(active),
        h.Tabindex(active ? 0 : -1),
        ...(config.panelId === undefined ? [] : [h.AriaControls(config.panelId)]),
        ...(item.onSelect === undefined ? [] : [h.OnClick(item.onSelect)]),
        h.DataAttribute("tab", item.id),
        ...presentation,
      ],
      children,
    )
  }
  const root = styleAttributes(h, segmented ? styles.segmented : styles.underline, config.style)
  if (asLinks)
    return h.nav(
      [
        h.AriaLabel(config.label),
        h.DataAttribute("slot", "tabs"),
        ...(config.attributes ?? []),
        ...root,
      ],
      config.items.map(tab),
    )
  return h.div(
    [
      h.Role("tablist"),
      h.AriaLabel(config.label),
      h.DataAttribute("slot", "tabs"),
      ...(config.attributes ?? []),
      ...root,
    ],
    config.items.map(tab),
  )
}

/** Tabs with an underline (page sections) or segmented (small option sets) look. */
export const tabs: {
  <Message>(h: HtmlBuilder<Message>, config: TabsConfig<Message>): Html
  <Message>(config: TabsConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
