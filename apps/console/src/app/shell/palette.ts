import { type PaletteItem, rankPalette } from "@akter/ui"
import { Option, Predicate } from "effect"
import * as Routes from "../navigation/routes.ts"
import { appDestinations, secondaryDestinations, settingsGroups } from "../navigation/sections.ts"
import { address } from "../workspace/model.ts"
import { ChoseTheme, type Message, OpenedDialog, RequestedHref, SignedOut } from "./message.ts"
import { Dialog, type Model } from "./model.ts"
import { currentProject } from "./sidebar.ts"

/**
 * Everything the palette can do from here: go to any page or setting, open a pinned actor, an actor
 * type or a recent deploy, and run the console's actions.
 */
export const paletteItems = (model: Model): ReadonlyArray<PaletteItem<Message>> => {
  const page = Option.getOrUndefined(model.page)
  const actorTypes = Predicate.isTagged(page, "ActorsPage") ? page.types : []
  const deploys = Predicate.isTagged(page, "DeploymentsPage") ? page.deploys : []
  const sender = model.workspace.pinned[0]
  return [
    ...[...appDestinations, ...secondaryDestinations].map((destination) => ({
      id: `page-${destination.id}`,
      label: destination.label,
      group: "Pages",
      icon: destination.icon,
      keywords: destination.keywords,
      onSelect: RequestedHref({ href: destination.href }),
    })),
    ...model.workspace.pinned.map((actor) => ({
      id: `actor-${address(actor)}`,
      label: address(actor),
      group: "Pinned actors",
      icon: "actors" as const,
      detail: actor.awake ? "awake" : "asleep",
      onSelect: RequestedHref({
        href: Routes.actor({ actorType: actor.actorType, key: actor.key }),
      }),
    })),
    ...actorTypes.map((type) => ({
      id: `type-${type.name}`,
      label: type.name,
      group: "Actor types",
      icon: "actors" as const,
      detail: type.commands.join(", "),
      onSelect: RequestedHref({ href: Routes.actorType({ actorType: type.name }) }),
    })),
    ...deploys.slice(0, 3).map((deploy) => ({
      id: `deploy-${deploy.commit}`,
      label: deploy.message,
      group: "Deployments",
      icon: "deployments" as const,
      detail: deploy.commit,
      onSelect: RequestedHref({ href: Routes.deployment({ commit: deploy.commit }) }),
    })),
    ...settingsGroups.flatMap((group) =>
      group.items.map((item) => ({
        id: `settings-${item.id}`,
        label:
          group.title === "Organization" && item.label === "General" ? "Organization" : item.label,
        group: "Settings",
        icon: item.icon,
        keywords: `settings ${item.keywords}`,
        onSelect: RequestedHref({ href: item.href }),
      })),
    ),
    ...(sender === undefined
      ? []
      : [
          {
            id: "action-send",
            label: "Send a command",
            group: "Actions",
            icon: "commands" as const,
            keywords: "call actor",
            onSelect: OpenedDialog({ dialog: Dialog.SendCommand({ address: address(sender) }) }),
          },
        ]),
    {
      id: "action-deploy",
      label: `Deploy ${currentProject(model)}`,
      group: "Actions",
      icon: "deployments",
      keywords: "ship release",
      onSelect: RequestedHref({ href: Routes.deployments() }),
    },
    {
      id: "action-theme-light",
      label: "Use the light theme",
      group: "Actions",
      icon: "sun",
      keywords: "appearance",
      onSelect: ChoseTheme({ preference: "light" }),
    },
    {
      id: "action-theme-dark",
      label: "Use the dark theme",
      group: "Actions",
      icon: "moon",
      keywords: "appearance",
      onSelect: ChoseTheme({ preference: "dark" }),
    },
    {
      id: "action-theme-system",
      label: "Match the system theme",
      group: "Actions",
      icon: "monitor",
      keywords: "appearance",
      onSelect: ChoseTheme({ preference: "system" }),
    },
    {
      id: "action-sign-out",
      label: "Sign out",
      group: "Actions",
      icon: "logout",
      keywords: "log out",
      onSelect: SignedOut(),
    },
  ]
}

/** The palette's results for the current query, in display order. */
export const paletteResults = (model: Model): ReadonlyArray<PaletteItem<Message>> => {
  const ranked = rankPalette({ items: paletteItems(model), query: model.palette.query })
  return model.palette.query.trim().length === 0
    ? ranked.filter((item) => item.group !== "Actor types")
    : ranked
}
