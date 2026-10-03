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
  layers,
  radius,
  shadows,
  space,
  typography,
} from "../tokens.stylex.ts"
import { avatar } from "./avatar.ts"
import { icon } from "./icon.ts"

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    height: "100%",
    minHeight: 0,
    paddingBlock: "0.625rem",
    paddingInline: space.sm,
    backgroundColor: colors.sidebar,
    borderInlineEndWidth: borders.hairline,
    borderInlineEndStyle: "solid",
    borderInlineEndColor: colors.border,
  },
  header: { display: "grid", gap: space.xs, paddingBlockEnd: space.sm },
  scroll: {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    flex: "1",
    minHeight: 0,
    overflowY: "auto",
    marginInline: `calc(-1 * ${space.sm})`,
    paddingInline: space.sm,
  },
  section: { display: "flex", flexDirection: "column", gap: "1px" },
  sectionTitle: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: "1.75rem",
    paddingBlockStart: "0.75rem",
    paddingInline: space.sm,
    color: colors.subtleForeground,
    fontSize: typography.caption,
    fontWeight: 460,
  },
  footer: {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    paddingBlockStart: space.sm,
  },
  back: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: dimensions.navItem,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    color: { default: colors.mutedForeground, ":hover": colors.foreground },
    fontWeight: typography.weightMedium,
    textDecoration: "none",
  },
  user: {
    display: "flex",
    alignItems: "center",
    gap: "0.5625rem",
    width: "100%",
    marginBlockStart: space.xs,
    paddingBlock: space.sm,
    paddingInline: space.sm,
    borderBlockStartWidth: borders.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
    borderRadius: 0,
    color: colors.foreground,
    fontWeight: 460,
    textAlign: "start",
    backgroundColor: { default: "transparent", ":hover": colors.accent },
  },
  userCopy: { display: "grid", minWidth: 0, flex: "1" },
  userName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  userDetail: { color: colors.subtleForeground, fontSize: typography.micro },
  frame: {
    display: "grid",
    gridTemplateColumns: {
      default: `${dimensions.sidebar} minmax(0, 1fr)`,
      [conditions.narrow]: "minmax(0, 1fr)",
    },
    height: "100dvh",
    backgroundColor: colors.background,
  },
  rail: {
    minHeight: 0,
    position: { default: "relative", [conditions.narrow]: "fixed" },
    insetBlock: { default: "auto", [conditions.narrow]: 0 },
    insetInlineStart: { default: "auto", [conditions.narrow]: 0 },
    zIndex: { default: "auto", [conditions.narrow]: layers.drawer },
    width: { default: "auto", [conditions.narrow]: "min(18rem, 86vw)" },
    translate: { default: "none", [conditions.narrow]: "-102% 0" },
    boxShadow: { default: "none", [conditions.narrow]: shadows.lg },
    transitionProperty: "translate",
  },
  railOpen: { translate: "none" },
  scrim: {
    display: { default: "none", [conditions.narrow]: "block" },
    position: "fixed",
    inset: 0,
    zIndex: layers.drawer,
    backgroundColor: colors.backdrop,
    cursor: "default",
  },
  main: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
    overflowY: "auto",
  },
  skip: {
    position: "fixed",
    insetBlockStart: space.sm,
    insetInlineStart: space.sm,
    zIndex: layers.tooltip,
    paddingBlock: space.s,
    paddingInline: space.md,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
    color: colors.primaryForeground,
    translate: { default: "0 -200%", ":focus": "none" },
  },
})

/** One block of sidebar links with an optional heading and heading action. */
export interface SidebarSection {
  readonly title?: string
  readonly action?: Html
  readonly items: Children
}

/**
 * The sidebar's header, sections and footer. `app` is the product navigation; `settings` is the
 * grouped settings navigation that replaces it, headed by a back link and a search field.
 */
export type SidebarConfig<Message> = SlotConfig<Message> &
  Readonly<{
    label: string
    variant: "app" | "settings"
    header: Children
    sections: ReadonlyArray<SidebarSection>
    footer: Children
  }>

const renderSidebar = <Message>(h: HtmlBuilder<Message>, config: SidebarConfig<Message>): Html =>
  h.div(
    [
      h.DataAttribute("slot", "sidebar"),
      h.DataAttribute("variant", config.variant),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.root, config.style),
    ],
    [
      h.div([...styleAttributes(h, styles.header)], [...config.header]),
      h.nav(
        [h.AriaLabel(config.label), ...styleAttributes(h, styles.scroll)],
        config.sections.map((section) =>
          h.div(
            [...styleAttributes(h, styles.section)],
            [
              section.title === undefined
                ? h.empty
                : h.div(
                    [...styleAttributes(h, styles.sectionTitle)],
                    [h.h2([], [section.title]), section.action ?? h.empty],
                  ),
              ...section.items,
            ],
          ),
        ),
      ),
      h.div([...styleAttributes(h, styles.footer)], [...config.footer]),
    ],
  )

/** The application or settings sidebar. */
export const sidebar: {
  <Message>(h: HtmlBuilder<Message>, config: SidebarConfig<Message>): Html
  <Message>(config: SidebarConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, renderSidebar)

/** The settings sidebar's way back to the product, labelled with where it leads. */
export const sidebarBack: {
  <Message>(h: HtmlBuilder<Message>, config: SidebarBackConfig): Html
  <Message>(config: SidebarBackConfig): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, <Message>(h: HtmlBuilder<Message>, config: SidebarBackConfig): Html =>
  h.a(
    [
      h.Href(config.href),
      h.AriaLabel(config.description),
      ...styleAttributes(h, styles.back, accessibility.focusInset, motionStyles.fast),
    ],
    [icon(h, { name: "arrowLeft" }), config.label],
  ),
)

/** Where the back link goes, what it shows, and what it announces. */
export type SidebarBackConfig = Readonly<{ href: string; label: string; description: string }>

/** The signed-in person at the foot of the sidebar; it opens the account menu. */
export type SidebarUserConfig<Message> = SlotConfig<Message> &
  Readonly<{
    name: string
    detail?: string
  }>

const renderUser = <Message>(h: HtmlBuilder<Message>, config: SidebarUserConfig<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.DataAttribute("slot", "sidebar-user"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.user, accessibility.focusInset, motionStyles.fast, config.style),
    ],
    [
      avatar(h, { name: config.name }),
      h.span(
        [...styleAttributes(h, styles.userCopy)],
        [
          h.span([...styleAttributes(h, styles.userName)], [config.name]),
          config.detail === undefined
            ? h.empty
            : h.span([...styleAttributes(h, styles.userDetail)], [config.detail]),
        ],
      ),
      icon(h, { name: "chevronUpDown", size: "small" }),
    ],
  )

/** The sidebar's account row. */
export const sidebarUser: {
  <Message>(h: HtmlBuilder<Message>, config: SidebarUserConfig<Message>): Html
  <Message>(config: SidebarUserConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, renderUser)

/**
 * The console frame: sidebar and main column side by side, and below the narrow breakpoint a
 * drawer that slides over the page with a scrim that closes it.
 */
export type AppFrameConfig<Message> = Readonly<{
  sidebar: Html
  main: Children
  drawerOpen: boolean
  onCloseDrawer: Message
  mainLabel: string
}>

const renderFrame = <Message>(h: HtmlBuilder<Message>, config: AppFrameConfig<Message>): Html =>
  h.div(
    [h.DataAttribute("slot", "app-frame"), ...styleAttributes(h, styles.frame)],
    [
      h.a([h.Href("#main"), ...styleAttributes(h, styles.skip)], ["Skip to content"]),
      config.drawerOpen
        ? h.button(
            [
              h.Type("button"),
              h.AriaLabel("Close navigation"),
              h.OnClick(config.onCloseDrawer),
              ...styleAttributes(h, styles.scrim),
            ],
            [],
          )
        : h.empty,
      h.aside(
        [
          h.Id("navigation"),
          h.DataAttribute("drawer", config.drawerOpen ? "open" : "closed"),
          ...styleAttributes(
            h,
            styles.rail,
            motionStyles.slow,
            config.drawerOpen && styles.railOpen,
          ),
        ],
        [config.sidebar],
      ),
      h.main(
        [
          h.Id("main"),
          h.AriaLabel(config.mainLabel),
          h.Tabindex(-1),
          ...styleAttributes(h, styles.main),
        ],
        [...config.main],
      ),
    ],
  )

/** The application frame around every signed-in page. */
export const appFrame: {
  <Message>(h: HtmlBuilder<Message>, config: AppFrameConfig<Message>): Html
  <Message>(config: AppFrameConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, renderFrame)
