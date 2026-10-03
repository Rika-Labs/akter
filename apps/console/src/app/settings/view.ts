import { AppRoute } from "../navigation/routes.ts"
import type { Screen, ScreenInput } from "../shell/screen.ts"
import { appearanceScreen, generalScreen, notificationsScreen, profileScreen } from "./account.ts"
import type { SettingsPage } from "./model.ts"
import {
  auditScreen,
  billingScreen,
  membersScreen,
  organizationScreen,
  usageScreen,
} from "./organization.ts"
import {
  domainsScreen,
  environmentScreen,
  integrationsScreen,
  keysScreen,
  regionsSettingsScreen,
} from "./project.ts"

/** The settings page the route names. */
export const settingsScreen = (input: ScreenInput<SettingsPage>): Screen =>
  AppRoute.matchOrElse(
    input.model.route,
    {
      SettingsAppearance: () => appearanceScreen(input),
      SettingsProfile: () => profileScreen(input),
      SettingsNotifications: () => notificationsScreen(input),
      SettingsEnvironment: () => environmentScreen(input),
      SettingsRegions: () => regionsSettingsScreen(input),
      SettingsDomains: () => domainsScreen(input),
      SettingsKeys: () => keysScreen(input),
      SettingsIntegrations: () => integrationsScreen(input),
      SettingsOrganization: () => organizationScreen(input),
      SettingsMembers: () => membersScreen(input),
      SettingsBilling: () => billingScreen(input),
      SettingsUsage: () => usageScreen(input),
      SettingsAudit: () => auditScreen(input),
    },
    () => generalScreen(input),
  )
