import {
  dropdownMenu,
  icon,
  iconButton,
  input,
  mark,
  navItem,
  pinnedItem,
  sidebar,
  sidebarBack,
  sidebarUser,
  styleAttributes,
} from "@akter/ui"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute } from "../navigation/routes.ts"
import * as Routes from "../navigation/routes.ts"
import { appDestinations, searchSettings } from "../navigation/sections.ts"
import { address } from "../workspace/model.ts"
import {
  ChangedSettingsQuery,
  ChoseTheme,
  ClosedDrawer,
  type Message,
  OpenedPalette,
  SignedOut,
} from "./message.ts"
import type { Model } from "./model.ts"
import { shellStyles as styles } from "./styles.ts"

const rememberedProject = (): string | null => {
  try {
    return window.sessionStorage.getItem("console-project")
  } catch {
    return null
  }
}

/**
 * The project the sidebar is scoped to: the route's project, else the one remembered for this tab
 * if the workspace still has it, else the workspace's first.
 */
export const currentProject = (model: Model): string => {
  if (AppRoute.isAnyOf(["Project"])(model.route)) return model.route.project
  const slugs = model.workspace.projects.map((project) => project.slug)
  const remembered = rememberedProject()
  if (remembered !== null && slugs.includes(remembered)) return remembered
  return slugs[0] ?? "No project"
}

const accountMenu = (h: HtmlBuilder<Message>, model: Model): Html =>
  dropdownMenu(h, {
    id: "account-menu",
    label: "Account",
    placement: "above",
    block: true,
    entries: [
      { kind: "heading", label: model.workspace.person.email },
      { kind: "item", label: "Profile", icon: "profile", href: Routes.settingsProfile() },
      { kind: "item", label: "Settings", icon: "settings", href: Routes.settingsGeneral() },
      { kind: "separator" },
      {
        kind: "item",
        label: "Light",
        icon: "sun",
        checked: model.theme === "light",
        onSelect: ChoseTheme({ preference: "light" }),
      },
      {
        kind: "item",
        label: "Dark",
        icon: "moon",
        checked: model.theme === "dark",
        onSelect: ChoseTheme({ preference: "dark" }),
      },
      {
        kind: "item",
        label: "System",
        icon: "monitor",
        checked: model.theme === "system",
        onSelect: ChoseTheme({ preference: "system" }),
      },
      { kind: "separator" },
      { kind: "item", label: "Sign out", icon: "logout", onSelect: SignedOut() },
    ],
    trigger: (attributes) =>
      sidebarUser(h, {
        name: model.workspace.person.name,
        detail: `${model.workspace.organization} · ${model.workspace.plan}`,
        attributes: [h.AriaLabel(`Account: ${model.workspace.person.name}`), ...attributes],
      }),
  })

const projectSwitcher = (h: HtmlBuilder<Message>, model: Model): Html => {
  const current = currentProject(model)
  return h.div(
    [...styleAttributes(h, styles.switcherRow)],
    [
      dropdownMenu(h, {
        id: "project-menu",
        label: "Projects",
        block: true,
        entries: [
          { kind: "heading", label: model.workspace.organization },
          ...model.workspace.projects.map((project) => ({
            kind: "item" as const,
            label: project.slug,
            detail: project.deployed ? project.region : "not deployed",
            checked: project.slug === current,
            href: Routes.project({ project: project.slug }),
          })),
          { kind: "separator" },
          {
            kind: "item",
            label: "New project",
            icon: "plus",
            href: Routes.onboarding({ step: "project" }),
          },
        ],
        trigger: (attributes) =>
          h.button(
            [
              h.Type("button"),
              h.AriaLabel(`Project: ${current}`),
              ...attributes,
              ...styleAttributes(h, styles.switcher),
            ],
            [
              mark(h, { size: 18 }),
              h.span([...styleAttributes(h, styles.switcherName)], [current]),
              h.span(
                [...styleAttributes(h, styles.switcherChevron)],
                [icon(h, { name: "chevronUpDown", size: "small" })],
              ),
            ],
          ),
      }),
      iconButton(h, { label: "Search  ⌘K", icon: "search", onClick: OpenedPalette() }),
      h.span(
        [...styleAttributes(h, styles.narrowOnly)],
        [
          iconButton(h, {
            label: "Close navigation",
            icon: "close",
            onClick: ClosedDrawer(),
            tooltip: "none",
          }),
        ],
      ),
    ],
  )
}

const appSidebar = (h: HtmlBuilder<Message>, model: Model): Html => {
  const open = Math.max(0, model.workspace.deadLetters - model.resolved.length)
  const inspected = AppRoute.isAnyOf(["Actor"])(model.route)
    ? `${model.route.actorType}/${model.route.key}`
    : ""
  return sidebar(h, {
    label: "Project",
    variant: "app",
    header: [projectSwitcher(h, model)],
    sections: [
      {
        items: appDestinations.map((destination) =>
          navItem(h, {
            label: destination.label,
            href: destination.href,
            icon: destination.icon,
            active: destination.active(model.route),
            count: destination.id === "jobs" && open > 0 ? String(open) : undefined,
            countTone: "alert",
          }),
        ),
      },
      {
        title: "Pinned actors",
        action: iconButton(h, {
          label: "Find an actor",
          icon: "plus",
          size: "sm",
          onClick: OpenedPalette(),
          tooltip: "right",
        }),
        items: model.workspace.pinned.map((actor) =>
          pinnedItem(h, {
            address: address(actor),
            href: Routes.actor({ actorType: actor.actorType, key: actor.key }),
            awake: actor.awake,
            time: actor.lastTurn,
            active: inspected === address(actor),
          }),
        ),
      },
    ],
    footer: [
      navItem(h, { label: "Settings", href: Routes.settingsGeneral(), icon: "settings" }),
      accountMenu(h, model),
    ],
  })
}

const settingsSidebar = (h: HtmlBuilder<Message>, model: Model): Html =>
  sidebar(h, {
    label: "Settings",
    variant: "settings",
    header: [
      h.div(
        [...styleAttributes(h, styles.switcherRow)],
        [
          sidebarBack(h, {
            href: Routes.overview(),
            label: "Settings",
            description: `Back to ${currentProject(model)}`,
          }),
          h.span(
            [...styleAttributes(h, styles.narrowOnly)],
            [
              iconButton(h, {
                label: "Close navigation",
                icon: "close",
                onClick: ClosedDrawer(),
                tooltip: "none",
              }),
            ],
          ),
        ],
      ),
      input(h, {
        name: "settings-search",
        label: "Search settings",
        value: model.settingsQuery,
        type: "search",
        placeholder: "Search settings",
        icon: "search",
        size: "sm",
        onInput: (query) => ChangedSettingsQuery({ query }),
      }),
    ],
    sections: searchSettings(model.settingsQuery).map((group) => ({
      title: group.title,
      items: group.items.map((item) =>
        navItem(h, {
          label: item.label,
          href: item.href,
          icon: item.icon,
          active: item.active(model.route),
        }),
      ),
    })),
    footer: [accountMenu(h, model)],
  })

/** The sidebar for the route: the product navigation, or the settings navigation inside Settings. */
export const sidebarView = (input: Readonly<{ h: HtmlBuilder<Message>; model: Model }>): Html =>
  Routes.isSettingsRoute(input.model.route)
    ? settingsSidebar(input.h, input.model)
    : appSidebar(input.h, input.model)
