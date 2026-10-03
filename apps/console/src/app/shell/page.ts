import { Effect, Option, Schema as S } from "effect"
import { fixturesEnabled, type ConsoleError, type Loaded } from "../api/client.ts"
import { ActorPage, ActorTypePage, ActorsPage } from "../actors/model.ts"
import { loadActor, loadActorType, loadActors } from "../actors/client.ts"
import { loadInvitation } from "../auth/client.ts"
import { InvitationPage } from "../auth/model.ts"
import { guardRoute } from "../auth/session.ts"
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

/** A page's data with the provenance its client reported; `none` renders as not found. */
export type LoadedPage = Loaded<Option.Option<PageData>>

const some = (effect: Effect.Effect<Loaded<PageData | undefined>, ConsoleError>) =>
  effect.pipe(
    Effect.map((loaded): LoadedPage => ({
      data: Option.fromNullishOr(loaded.data),
      sample: loaded.sample,
    })),
  )

const none = Effect.sync((): LoadedPage => ({ data: Option.none(), sample: fixturesEnabled() }))

const pageFor = (route: AppRoute): Effect.Effect<LoadedPage, ConsoleError> =>
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
    SettingsGeneral: () => some(loadSettings(route)),
    SettingsAppearance: () => some(loadSettings(route)),
    SettingsProfile: () => some(loadSettings(route)),
    SettingsNotifications: () => some(loadSettings(route)),
    SettingsEnvironment: () => some(loadSettings(route)),
    SettingsRegions: () => some(loadSettings(route)),
    SettingsDomains: () => some(loadSettings(route)),
    SettingsKeys: () => some(loadSettings(route)),
    SettingsIntegrations: () => some(loadSettings(route)),
    SettingsOrganization: () => some(loadSettings(route)),
    SettingsMembers: () => some(loadSettings(route)),
    SettingsBilling: () => some(loadSettings(route)),
    SettingsUsage: () => some(loadSettings(route)),
    SettingsAudit: () => some(loadSettings(route)),
    NotFound: () => none,
  })

/**
 * Loads the data a route renders after checking the session the route needs. `none` means the route
 * needs no data (sign-in, settings that read only preferences) or names something that does not
 * exist, which renders as not found. A failure carries the `ConsoleError` the page shows;
 * `Unauthorized` and `SignedIn` mean the shell should redirect instead. `allowSignIn` is passed to
 * the session guard so a refused API session can still reach the sign-in screen.
 */
export const loadPage = (
  input: Readonly<{ route: AppRoute; allowSignIn?: boolean }>,
): Effect.Effect<LoadedPage, ConsoleError> =>
  guardRoute(input).pipe(Effect.andThen(pageFor(input.route)))
