import { Schema as S, pipe } from "effect"
import * as Route from "foldkit/route"

/** Every page the console can show, parsed from and printed to the URL. */
export const AppRoute = Route.defineRouteUnion({
  SignIn: {},
  SignUp: {},
  VerifyEmail: {},
  ForgotPassword: {},
  ResetPassword: {},
  AcceptInvitation: { invitation: S.String },
  Device: { user_code: S.optional(S.String) },
  Onboarding: { step: S.optional(S.String) },
  Overview: {},
  Project: { project: S.String },
  Actors: {},
  ActorType: { actorType: S.String },
  Actor: { actorType: S.String, key: S.String, tab: S.optional(S.String) },
  Commands: {},
  Jobs: {},
  Workflows: {},
  Connections: {},
  Deployments: {},
  Deployment: { deployment: S.String },
  Regions: {},
  SettingsGeneral: {},
  SettingsAppearance: {},
  SettingsProfile: {},
  SettingsNotifications: {},
  SettingsEnvironment: {},
  SettingsRegions: {},
  SettingsDomains: {},
  SettingsKeys: {},
  SettingsIntegrations: {},
  SettingsOrganization: {},
  SettingsMembers: {},
  SettingsBilling: {},
  SettingsUsage: {},
  SettingsAudit: {},
  NotFound: { path: S.String },
})

/** A parsed console route. */
export type AppRoute = typeof AppRoute.Type

/**
 * Wraps a route member as a plain `{ make }` object. FoldKit 0.163 exposes each union member through
 * a Proxy, and Effect 4.0's schemas cache `make` with `defineProperty` on the receiver, so reading
 * `.make` through the Proxy twice throws; calling the member directly takes FoldKit's own
 * constructor path instead. The wrapper declares its parameter because `mapTo` passes parsed values
 * only to a `make` whose arity is non-zero.
 */
const using = <Input, Output>(member: (input: Input) => Output) => ({
  make: (input: Input): Output => member(input),
})

const construct = {
  SignIn: using(AppRoute.SignIn),
  SignUp: using(AppRoute.SignUp),
  VerifyEmail: using(AppRoute.VerifyEmail),
  ForgotPassword: using(AppRoute.ForgotPassword),
  ResetPassword: using(AppRoute.ResetPassword),
  AcceptInvitation: using(AppRoute.AcceptInvitation),
  Device: using(AppRoute.Device),
  Onboarding: using(AppRoute.Onboarding),
  Overview: using(AppRoute.Overview),
  Project: using(AppRoute.Project),
  Actors: using(AppRoute.Actors),
  ActorType: using(AppRoute.ActorType),
  Actor: using(AppRoute.Actor),
  Commands: using(AppRoute.Commands),
  Jobs: using(AppRoute.Jobs),
  Workflows: using(AppRoute.Workflows),
  Connections: using(AppRoute.Connections),
  Deployments: using(AppRoute.Deployments),
  Deployment: using(AppRoute.Deployment),
  Regions: using(AppRoute.Regions),
  SettingsGeneral: using(AppRoute.SettingsGeneral),
  SettingsAppearance: using(AppRoute.SettingsAppearance),
  SettingsProfile: using(AppRoute.SettingsProfile),
  SettingsNotifications: using(AppRoute.SettingsNotifications),
  SettingsEnvironment: using(AppRoute.SettingsEnvironment),
  SettingsRegions: using(AppRoute.SettingsRegions),
  SettingsDomains: using(AppRoute.SettingsDomains),
  SettingsKeys: using(AppRoute.SettingsKeys),
  SettingsIntegrations: using(AppRoute.SettingsIntegrations),
  SettingsOrganization: using(AppRoute.SettingsOrganization),
  SettingsMembers: using(AppRoute.SettingsMembers),
  SettingsBilling: using(AppRoute.SettingsBilling),
  SettingsUsage: using(AppRoute.SettingsUsage),
  SettingsAudit: using(AppRoute.SettingsAudit),
  NotFound: using(AppRoute.NotFound),
}

const page = (segment: string) => Route.literal(segment)
const settingsRoot = page("settings")
const setting = (segment: string) => pipe(settingsRoot, Route.slash(page(segment)))

export const signIn = pipe(page("sign-in"), Route.mapTo(construct.SignIn))
export const signUp = pipe(page("sign-up"), Route.mapTo(construct.SignUp))
export const verifyEmail = pipe(page("verify-email"), Route.mapTo(construct.VerifyEmail))
export const forgotPassword = pipe(page("forgot-password"), Route.mapTo(construct.ForgotPassword))
export const resetPassword = pipe(page("reset-password"), Route.mapTo(construct.ResetPassword))
export const acceptInvitation = pipe(
  page("invitations"),
  Route.slash(Route.string("invitation")),
  Route.mapTo(construct.AcceptInvitation),
)

export const device = pipe(
  page("device"),
  Route.query(S.Struct({ user_code: S.optional(S.String) })),
  Route.mapTo(construct.Device),
)

export const onboarding = pipe(
  page("onboarding"),
  Route.query(S.Struct({ step: S.optional(S.String) })),
  Route.mapTo(construct.Onboarding),
)
export const overview = pipe(Route.root, Route.mapTo(construct.Overview))
export const project = pipe(
  page("projects"),
  Route.slash(Route.string("project")),
  Route.mapTo(construct.Project),
)
export const actors = pipe(page("actors"), Route.mapTo(construct.Actors))
export const actorType = pipe(
  page("actors"),
  Route.slash(Route.string("actorType")),
  Route.mapTo(construct.ActorType),
)
export const actor = pipe(
  page("actors"),
  Route.slash(Route.string("actorType")),
  Route.slash(Route.string("key")),
  Route.query(S.Struct({ tab: S.optional(S.String) })),
  Route.mapTo(construct.Actor),
)
export const commands = pipe(page("commands"), Route.mapTo(construct.Commands))
export const jobs = pipe(page("jobs"), Route.mapTo(construct.Jobs))
export const workflows = pipe(page("workflows"), Route.mapTo(construct.Workflows))
export const connections = pipe(page("connections"), Route.mapTo(construct.Connections))
export const deployments = pipe(page("deployments"), Route.mapTo(construct.Deployments))
export const deployment = pipe(
  page("deployments"),
  Route.slash(Route.string("deployment")),
  Route.mapTo(construct.Deployment),
)
export const regions = pipe(page("regions"), Route.mapTo(construct.Regions))
export const settingsGeneral = pipe(settingsRoot, Route.mapTo(construct.SettingsGeneral))
export const settingsAppearance = pipe(
  setting("appearance"),
  Route.mapTo(construct.SettingsAppearance),
)
export const settingsProfile = pipe(setting("profile"), Route.mapTo(construct.SettingsProfile))
export const settingsNotifications = pipe(
  setting("notifications"),
  Route.mapTo(construct.SettingsNotifications),
)
export const settingsEnvironment = pipe(
  setting("environment"),
  Route.mapTo(construct.SettingsEnvironment),
)
export const settingsRegions = pipe(setting("regions"), Route.mapTo(construct.SettingsRegions))
export const settingsDomains = pipe(setting("domains"), Route.mapTo(construct.SettingsDomains))
export const settingsKeys = pipe(setting("api-keys"), Route.mapTo(construct.SettingsKeys))
export const settingsIntegrations = pipe(
  setting("integrations"),
  Route.mapTo(construct.SettingsIntegrations),
)
export const settingsOrganization = pipe(
  setting("organization"),
  Route.mapTo(construct.SettingsOrganization),
)
export const settingsMembers = pipe(setting("members"), Route.mapTo(construct.SettingsMembers))
export const settingsBilling = pipe(setting("billing"), Route.mapTo(construct.SettingsBilling))
export const settingsUsage = pipe(setting("usage"), Route.mapTo(construct.SettingsUsage))
export const settingsAudit = pipe(setting("audit-log"), Route.mapTo(construct.SettingsAudit))

const parser = Route.oneOf(
  signIn,
  signUp,
  verifyEmail,
  forgotPassword,
  resetPassword,
  acceptInvitation,
  device,
  onboarding,
  project,
  actor,
  actorType,
  actors,
  commands,
  jobs,
  workflows,
  connections,
  deployment,
  deployments,
  regions,
  settingsAppearance,
  settingsProfile,
  settingsNotifications,
  settingsEnvironment,
  settingsRegions,
  settingsDomains,
  settingsKeys,
  settingsIntegrations,
  settingsOrganization,
  settingsMembers,
  settingsBilling,
  settingsUsage,
  settingsAudit,
  settingsGeneral,
  overview,
)

/** Parses a URL into a route; anything unknown is the not-found page. */
export const parseUrl = Route.parseUrlWithFallback(parser, construct.NotFound)

/**
 * Routes drawn without the application frame: sign-in, recovery, invitations, device sign-in and
 * onboarding.
 */
export const isAuthRoute = AppRoute.isAnyOf([
  "SignIn",
  "SignUp",
  "VerifyEmail",
  "ForgotPassword",
  "ResetPassword",
  "AcceptInvitation",
  "Device",
  "Onboarding",
])

/** Routes that swap the sidebar for the grouped settings navigation. */
export const isSettingsRoute = AppRoute.isAnyOf([
  "SettingsGeneral",
  "SettingsAppearance",
  "SettingsProfile",
  "SettingsNotifications",
  "SettingsEnvironment",
  "SettingsRegions",
  "SettingsDomains",
  "SettingsKeys",
  "SettingsIntegrations",
  "SettingsOrganization",
  "SettingsMembers",
  "SettingsBilling",
  "SettingsUsage",
  "SettingsAudit",
])
