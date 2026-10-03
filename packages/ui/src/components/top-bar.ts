import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { accessibility } from "../design/accessibility.ts"
import { styleAttributes } from "../design/attributes.ts"
import type { Children, SlotConfig } from "../design/contracts.ts"
import { borders, colors, conditions, dimensions, space, typography } from "../tokens.stylex.ts"

const styles = stylex.create({
  bar: {
    position: "sticky",
    insetBlockStart: 0,
    zIndex: 5,
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flexShrink: 0,
    height: dimensions.topBar,
    paddingInline: { default: "1.25rem", [conditions.narrow]: space.md },
    borderBottomWidth: borders.hairline,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    backgroundColor: colors.background,
  },
  crumbs: { minWidth: 0, flex: "1", overflow: "hidden" },
  list: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    minWidth: 0,
    whiteSpace: "nowrap",
    color: colors.mutedForeground,
  },
  item: { display: "inline-flex", alignItems: "center", gap: space.sm, minWidth: 0 },
  hiddenNarrow: { display: { default: "inline-flex", [conditions.narrow]: "none" } },
  link: {
    color: { default: colors.mutedForeground, ":hover": colors.foreground },
    textDecoration: "none",
    borderRadius: "3px",
  },
  current: {
    color: colors.foreground,
    fontWeight: typography.weightMedium,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  mono: { fontFamily: typography.mono, fontSize: typography.small },
  separator: { color: colors.subtleForeground },
  actions: { display: "flex", alignItems: "center", gap: space.s, flexShrink: 0 },
})

/** One breadcrumb. The last crumb is the current page and is not a link. */
export interface Crumb {
  readonly label: string
  readonly href?: string
  readonly mono?: boolean
}

/** The bar's crumbs, a leading slot (the narrow-screen menu button) and trailing actions. */
export type TopBarConfig<Message> = SlotConfig<Message> &
  Readonly<{
    crumbs: ReadonlyArray<Crumb>
    leading?: Html
    actions?: Children
  }>

/** Breadcrumbs as an ordered list in a labelled navigation landmark. */
export const breadcrumb: {
  <Message>(h: HtmlBuilder<Message>, crumbs: ReadonlyArray<Crumb>): Html
  (crumbs: ReadonlyArray<Crumb>): <Message>(h: HtmlBuilder<Message>) => Html
} = Function.dual(2, <Message>(h: HtmlBuilder<Message>, crumbs: ReadonlyArray<Crumb>): Html =>
  h.nav(
    [h.AriaLabel("Breadcrumb"), ...styleAttributes(h, styles.crumbs)],
    [
      h.ol(
        [...styleAttributes(h, styles.list)],
        crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1
          const label =
            last || crumb.href === undefined
              ? h.span(
                  [
                    ...(last ? [h.AriaCurrent("page")] : []),
                    ...styleAttributes(
                      h,
                      last && styles.current,
                      crumb.mono === true && styles.mono,
                    ),
                  ],
                  [crumb.label],
                )
              : h.a(
                  [
                    h.Href(crumb.href),
                    ...styleAttributes(
                      h,
                      styles.link,
                      accessibility.focusRing,
                      crumb.mono === true && styles.mono,
                    ),
                  ],
                  [crumb.label],
                )
          return h.li(
            [...styleAttributes(h, styles.item, index < crumbs.length - 2 && styles.hiddenNarrow)],
            [
              index === 0
                ? h.empty
                : h.span([h.AriaHidden(true), ...styleAttributes(h, styles.separator)], ["/"]),
              label,
            ],
          )
        }),
      ),
    ],
  ),
)

const render = <Message>(h: HtmlBuilder<Message>, config: TopBarConfig<Message>): Html =>
  h.header(
    [
      h.DataAttribute("slot", "top-bar"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.bar, config.style),
    ],
    [
      config.leading ?? h.empty,
      breadcrumb(h, config.crumbs),
      config.actions === undefined
        ? h.empty
        : h.div([...styleAttributes(h, styles.actions)], [...config.actions]),
    ],
  )

/** The page's top bar: where you are on the left, what you can do on the right. */
export const topBar: {
  <Message>(h: HtmlBuilder<Message>, config: TopBarConfig<Message>): Html
  <Message>(config: TopBarConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
