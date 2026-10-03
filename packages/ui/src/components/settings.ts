import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { accessibility } from "../design/accessibility.ts"
import { styleAttributes } from "../design/attributes.ts"
import type { Children, SlotConfig } from "../design/contracts.ts"
import { motionStyles } from "../design/motion.ts"
import {
  borders,
  colors,
  conditions,
  dimensions,
  radius,
  space,
  typography,
} from "../tokens.stylex.ts"
import { icon, type IconName } from "./icon.ts"

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space.xxl,
    width: "100%",
    maxWidth: dimensions.settingsColumn,
    marginInline: "auto",
    paddingBlockStart: { default: "2.75rem", [conditions.narrow]: space.xl },
    paddingBlockEnd: space.huge,
    paddingInline: { default: space.xxl, [conditions.narrow]: space.lg },
  },
  title: {
    fontSize: typography.heading,
    fontWeight: typography.weightStrong,
    letterSpacing: "-0.3px",
    lineHeight: typography.leadingTight,
  },
  intro: { display: "grid", gap: space.s },
  lead: { color: colors.mutedForeground, maxWidth: "36rem" },
  group: { display: "flex", flexDirection: "column", minWidth: 0 },
  groupHead: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: space.md,
    marginBlockEnd: "0.625rem",
  },
  groupTitle: { fontSize: "0.875rem", fontWeight: typography.weightStrong },
  groupDescription: {
    marginBlockStart: space.xxs,
    color: colors.mutedForeground,
    fontSize: typography.small,
  },
  card: {
    borderWidth: borders.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    overflow: "hidden",
  },
  groupFoot: {
    marginBlockStart: "0.625rem",
    color: colors.mutedForeground,
    fontSize: typography.small,
  },
  row: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space.lg,
    minHeight: dimensions.settingsRow,
    paddingBlock: "0.625rem",
    paddingInline: space.lg,
    borderBlockStartWidth: borders.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: { default: colors.border, ":first-child": "transparent" },
    flexWrap: { default: "nowrap", [conditions.compact]: "wrap" },
  },
  rowLink: {
    textDecoration: "none",
    color: "inherit",
    backgroundColor: { default: "transparent", ":hover": colors.muted },
    transitionProperty: "background-color",
  },
  rowIcon: {
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    width: "1.75rem",
    height: "1.75rem",
    borderWidth: borders.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.sm,
    color: colors.foreground,
  },
  copy: { display: "grid", gap: space.xxs, flex: "1", minWidth: "min(100%, 12rem)" },
  label: { fontWeight: typography.weightMedium, overflowWrap: "anywhere" },
  mono: { fontFamily: typography.mono, fontSize: typography.small, fontWeight: 450 },
  description: { color: colors.mutedForeground, fontSize: typography.small },
  control: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flexShrink: 0,
    marginInlineStart: "auto",
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  chevron: { color: colors.subtleForeground, display: "inline-flex" },
  danger: { color: colors.destructive },
})

/** A settings page: a narrow centred column with one title and grouped rows below it. */
export type SettingsPageConfig<Message> = SlotConfig<Message> &
  Readonly<{
    title: string
    description?: string
    children: Children
  }>

const renderPage = <Message>(h: HtmlBuilder<Message>, config: SettingsPageConfig<Message>): Html =>
  h.div(
    [
      h.DataAttribute("slot", "settings-page"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.page, config.style),
    ],
    [
      h.div(
        [...styleAttributes(h, styles.intro)],
        [
          h.h1([...styleAttributes(h, styles.title)], [config.title]),
          config.description === undefined
            ? h.empty
            : h.p([...styleAttributes(h, styles.lead)], [config.description]),
        ],
      ),
      ...config.children,
    ],
  )

/** The settings column. */
export const settingsPage: {
  <Message>(h: HtmlBuilder<Message>, config: SettingsPageConfig<Message>): Html
  <Message>(config: SettingsPageConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, renderPage)

/** A titled card of rows, with an optional action beside the title and a note below. */
export type SettingsGroupConfig<Message> = SlotConfig<Message> &
  Readonly<{
    title?: string
    description?: string
    action?: Html
    rows: Children
    footnote?: string
  }>

const renderGroup = <Message>(
  h: HtmlBuilder<Message>,
  config: SettingsGroupConfig<Message>,
): Html =>
  h.section(
    [
      h.DataAttribute("slot", "settings-group"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.group, config.style),
    ],
    [
      config.title === undefined && config.action === undefined
        ? h.empty
        : h.div(
            [...styleAttributes(h, styles.groupHead)],
            [
              h.div(
                [],
                [
                  config.title === undefined
                    ? h.empty
                    : h.h2([...styleAttributes(h, styles.groupTitle)], [config.title]),
                  config.description === undefined
                    ? h.empty
                    : h.p([...styleAttributes(h, styles.groupDescription)], [config.description]),
                ],
              ),
              config.action ?? h.empty,
            ],
          ),
      h.div([...styleAttributes(h, styles.card)], [...config.rows]),
      config.footnote === undefined
        ? h.empty
        : h.p([...styleAttributes(h, styles.groupFoot)], [config.footnote]),
    ],
  )

/** A group of settings rows. */
export const settingsGroup: {
  <Message>(h: HtmlBuilder<Message>, config: SettingsGroupConfig<Message>): Html
  <Message>(config: SettingsGroupConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, renderGroup)

/**
 * One setting: a label on the left and one control on the right. With `href` the whole row is a
 * link and ends in a chevron.
 */
export type SettingsRowConfig<Message> = SlotConfig<Message> &
  Readonly<{
    label: string
    description?: string
    icon?: IconName
    control?: Html
    href?: string
    mono?: boolean
    tone?: "default" | "danger"
  }>

const renderRow = <Message>(h: HtmlBuilder<Message>, config: SettingsRowConfig<Message>): Html => {
  const children = [
    config.icon === undefined
      ? h.empty
      : h.span([...styleAttributes(h, styles.rowIcon)], [icon(h, { name: config.icon })]),
    h.div(
      [...styleAttributes(h, styles.copy)],
      [
        h.span(
          [
            ...styleAttributes(
              h,
              styles.label,
              config.mono === true && styles.mono,
              config.tone === "danger" && styles.danger,
            ),
          ],
          [config.label],
        ),
        config.description === undefined
          ? h.empty
          : h.span([...styleAttributes(h, styles.description)], [config.description]),
      ],
    ),
    config.control === undefined && config.href === undefined
      ? h.empty
      : h.div(
          [...styleAttributes(h, styles.control)],
          [
            config.control ?? h.empty,
            config.href === undefined
              ? h.empty
              : h.span(
                  [...styleAttributes(h, styles.chevron)],
                  [icon(h, { name: "chevronRight" })],
                ),
          ],
        ),
  ]
  if (config.href !== undefined)
    return h.a(
      [
        h.Href(config.href),
        h.DataAttribute("slot", "settings-row"),
        ...(config.attributes ?? []),
        ...styleAttributes(
          h,
          styles.row,
          styles.rowLink,
          accessibility.focusInset,
          motionStyles.fast,
          config.style,
        ),
      ],
      children,
    )
  return h.div(
    [
      h.DataAttribute("slot", "settings-row"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.row, config.style),
    ],
    children,
  )
}

/** A settings row. */
export const settingsRow: {
  <Message>(h: HtmlBuilder<Message>, config: SettingsRowConfig<Message>): Html
  <Message>(config: SettingsRowConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, renderRow)
