import { Effect, Option, Schema as S } from "effect"
import { ActorPage, ActorTypePage, ActorsPage } from "../actors/model.ts"
import { loadActor, loadActorType, loadActors } from "../actors/client.ts"
import { loadInvitation } from "../auth/client.ts"
import { InvitationPage } from "../auth/model.ts"
import { loadCommands } from "../commands/client.ts"
import { CommandsPage } from "../commands/model.ts"
import { loadConnections } from "../connections/client.ts"
import { ConnectionsPage } from "../connections/model.ts"
import { loadDeployment, loadDeployments } from "../deployments/client.ts"
import { DeploymentPage, DeploymentsPage } from "../deployments/model.ts"
import { loadJobs } from "../jobs/client.ts"
import { JobsPage } from "../jobs/model.ts"
import { AppRoute } from "../navigation/routes.ts"
import { loadOverview, loadProject } from "../overview/client.ts"
import { EmptyProjectPage, OverviewPage } from "../overview/model.ts"
import { loadRegions } from "../regions/client.ts"
import { RegionsPage } from "../regions/model.ts"
import { loadSettings } from "../settings/client.ts"
import { SettingsPage } from "../settings/model.ts"
import { loadWorkflows } from "../workflows/client.ts"
import { WorkflowsPage } from "../workflows/model.ts"

/** The data behind whichever page is open, loaded by the route's client. */
export const PageData = S.Union([
  OverviewPage,
  EmptyProjectPage,
  ActorsPage,
  ActorTypePage,
  ActorPage,
  CommandsPage,
  JobsPage,
  WorkflowsPage,
  ConnectionsPage,
  DeploymentsPage,
  DeploymentPage,
  RegionsPage,
  SettingsPage,
  InvitationPage,
])
export type PageData = typeof PageData.Type

const some = (effect: Effect.Effect<PageData | undefined>) =>
  effect.pipe(Effect.map((data) => Option.fromNullishOr(data)))

const none = Effect.succeed(Option.none<PageData>())

/**
 * Loads the data a route renders. `none` means the route needs no data (sign-in, settings that read
 * only preferences) or names something that does not exist, which renders as not found.
 */
export const loadPage = (route: AppRoute): Effect.Effect<Option.Option<PageData>> =>
  AppRoute.match(route, {
    SignIn: () => none,
    SignUp: () => none,
    VerifyEmail: () => none,
    ForgotPassword: () => none,
    ResetPassword: () => none,
    AcceptInvitation: ({ invitation }) => some(loadInvitation(invitation)),
    Onboarding: () => none,
    Overview: () => some(loadOverview),
    Project: ({ project }) => some(loadProject(project)),
    Actors: () => some(loadActors),
    ActorType: ({ actorType }) => some(loadActorType(actorType)),
    Actor: ({ actorType, key }) => some(loadActor({ actorType, key })),
    Commands: () => some(loadCommands),
    Jobs: () => some(loadJobs),
    Workflows: () => some(loadWorkflows),
    Connections: () => some(loadConnections),
    Deployments: () => some(loadDeployments),
    Deployment: ({ commit }) => some(loadDeployment(commit)),
    Regions: () => some(loadRegions),
    SettingsGeneral: () => some(loadSettings),
    SettingsAppearance: () => some(loadSettings),
    SettingsProfile: () => some(loadSettings),
    SettingsNotifications: () => some(loadSettings),
    SettingsEnvironment: () => some(loadSettings),
    SettingsRegions: () => some(loadSettings),
    SettingsDomains: () => some(loadSettings),
    SettingsKeys: () => some(loadSettings),
    SettingsIntegrations: () => some(loadSettings),
    SettingsOrganization: () => some(loadSettings),
    SettingsMembers: () => some(loadSettings),
    SettingsBilling: () => some(loadSettings),
    SettingsUsage: () => some(loadSettings),
    SettingsAudit: () => some(loadSettings),
    NotFound: () => none,
  })
