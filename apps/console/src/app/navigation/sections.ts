import type { IconName } from "@akter/ui"
import { AppRoute } from "./routes.ts"
import * as Routes from "./routes.ts"

/** A destination in a navigation list. */
export interface Destination {
  readonly id: string
  readonly label: string
  readonly href: string
  readonly icon: IconName
  readonly keywords: string
  readonly active: (route: AppRoute) => boolean
}

/** The product sidebar's destinations, in order. */
export const appDestinations: ReadonlyArray<Destination> = [
  {
    id: "overview",
    label: "Overview",
    href: Routes.overview(),
    icon: "overview",
    keywords: "home dashboard throughput health",
    active: AppRoute.isAnyOf(["Overview", "Project"]),
  },
  {
    id: "actors",
    label: "Actors",
    href: Routes.actors(),
    icon: "actors",
    keywords: "types instances inspector state",
    active: AppRoute.isAnyOf(["Actors", "ActorType", "Actor"]),
  },
  {
    id: "commands",
    label: "Commands",
    href: Routes.commands(),
    icon: "commands",
    keywords: "live tail turns",
    active: AppRoute.isAnyOf(["Commands"]),
  },
  {
    id: "jobs",
    label: "Jobs",
    href: Routes.jobs(),
    icon: "jobs",
    keywords: "dead letters retries queue",
    active: AppRoute.isAnyOf(["Jobs"]),
  },
  {
    id: "workflows",
    label: "Workflows",
    href: Routes.workflows(),
    icon: "workflows",
    keywords: "timers schedules cron",
    active: AppRoute.isAnyOf(["Workflows"]),
  },
  {
    id: "connections",
    label: "Connections",
    href: Routes.connections(),
    icon: "connections",
    keywords: "sockets websocket sse feeds parked",
    active: AppRoute.isAnyOf(["Connections"]),
  },
  {
    id: "deployments",
    label: "Deployments",
    href: Routes.deployments(),
    icon: "deployments",
    keywords: "deploy rollout runners build",
    active: AppRoute.isAnyOf(["Deployments", "Deployment"]),
  },
]

/** Destinations reached from pages and the palette rather than the sidebar. */
export const secondaryDestinations: ReadonlyArray<Destination> = [
  {
    id: "regions",
    label: "Regions & database",
    href: Routes.regions(),
    icon: "regions",
    keywords: "database postgres neki tables storage",
    active: AppRoute.isAnyOf(["Regions"]),
  },
]

/** A titled group of settings pages. */
export interface SettingsGroup {
  readonly title?: string
  readonly items: ReadonlyArray<Destination>
}

const settingsPage = (
  id: string,
  label: string,
  href: string,
  icon: IconName,
  keywords: string,
  tag: AppRoute["_tag"],
): Destination => ({ id, label, href, icon, keywords, active: AppRoute.isAnyOf([tag]) })

/** The settings navigation that replaces the sidebar while Settings is open. */
export const settingsGroups: ReadonlyArray<SettingsGroup> = [
  {
    items: [
      settingsPage(
        "general",
        "General",
        Routes.settingsGeneral(),
        "user",
        "interface time zone live tail environment",
        "SettingsGeneral",
      ),
      settingsPage(
        "appearance",
        "Appearance",
        Routes.settingsAppearance(),
        "sun",
        "theme dark light system density",
        "SettingsAppearance",
      ),
      settingsPage(
        "profile",
        "Profile",
        Routes.settingsProfile(),
        "profile",
        "name email password two-factor sessions",
        "SettingsProfile",
      ),
      settingsPage(
        "notifications",
        "Notifications",
        Routes.settingsNotifications(),
        "bell",
        "email slack alerts",
        "SettingsNotifications",
      ),
    ],
  },
  {
    title: "Project",
    items: [
      settingsPage(
        "environment",
        "Environment",
        Routes.settingsEnvironment(),
        "environment",
        "variables secrets env",
        "SettingsEnvironment",
      ),
      settingsPage(
        "regions",
        "Regions",
        Routes.settingsRegions(),
        "regions",
        "home region replicas residency",
        "SettingsRegions",
      ),
      settingsPage(
        "domains",
        "Domains",
        Routes.settingsDomains(),
        "link",
        "dns custom domain certificate",
        "SettingsDomains",
      ),
      settingsPage(
        "keys",
        "API keys",
        Routes.settingsKeys(),
        "key",
        "tokens http openapi mcp endpoints",
        "SettingsKeys",
      ),
      settingsPage(
        "integrations",
        "Integrations",
        Routes.settingsIntegrations(),
        "plug",
        "github slack datadog opentelemetry pagerduty",
        "SettingsIntegrations",
      ),
    ],
  },
  {
    title: "Organization",
    items: [
      settingsPage(
        "organization",
        "General",
        Routes.settingsOrganization(),
        "organization",
        "organization name slug delete",
        "SettingsOrganization",
      ),
      settingsPage(
        "members",
        "Members",
        Routes.settingsMembers(),
        "team",
        "invite roles people team",
        "SettingsMembers",
      ),
      settingsPage(
        "billing",
        "Billing",
        Routes.settingsBilling(),
        "card",
        "stripe plan invoices payment spend limit",
        "SettingsBilling",
      ),
      settingsPage(
        "usage",
        "Usage",
        Routes.settingsUsage(),
        "usage",
        "meters commands runner hours storage egress",
        "SettingsUsage",
      ),
      settingsPage(
        "audit",
        "Audit log",
        Routes.settingsAudit(),
        "log",
        "history events security",
        "SettingsAudit",
      ),
    ],
  },
]

/** Settings groups narrowed to pages whose label or keywords contain `query`. */
export const searchSettings = (query: string): ReadonlyArray<SettingsGroup> => {
  const needle = query.trim().toLocaleLowerCase()
  if (needle.length === 0) return settingsGroups
  return settingsGroups.flatMap((group) => {
    const items = group.items.filter((item) =>
      `${item.label} ${item.keywords} ${group.title ?? ""}`.toLocaleLowerCase().includes(needle),
    )
    return items.length === 0 ? [] : [{ ...group, items }]
  })
}
