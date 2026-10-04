import {
  appFrame,
  commandPalette,
  iconButton,
  settingsRow,
  styleAttributes,
  toaster,
  topBar,
} from "@akter/ui"
import { Function, Option } from "effect"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { actorScreen, missingActorScreen } from "../actors/inspector/view.ts"
import { actorTypeScreen } from "../actors/type/view.ts"
import { actorsScreen } from "../actors/view.ts"
import { authScreen } from "../auth/view.ts"
import { commandsScreen } from "../commands/view.ts"
import { connectionsScreen } from "../connections/view.ts"
import { deploymentScreen } from "../deployments/detail/view.ts"
import { deploymentsScreen } from "../deployments/view.ts"
import { jobsScreen } from "../jobs/view.ts"
import { notFoundScreen } from "../missing/view.ts"
import { AppRoute, isAuthRoute, isSettingsRoute } from "../navigation/routes.ts"
import { emptyProjectScreen, overviewScreen } from "../overview/view.ts"
import { regionsScreen } from "../regions/view.ts"
import { settingsScreen } from "../settings/view.ts"
import { workflowsScreen } from "../workflows/view.ts"
import { dialogView } from "./dialogs.ts"
import { failureScreen } from "./failure.ts"
import {
  ChangedPaletteQuery,
  ChosePaletteItem,
  ClosedDrawer,
  ClosedPalette,
  DismissedToast,
  HighlightedPaletteItem,
  type Message,
  MovedPaletteSelection,
  ToggledDrawer,
} from "./message.ts"
import type { Model } from "./model.ts"
import type { PageData } from "./page.ts"
import { paletteResults } from "./palette.ts"
import { pageOf, type Screen } from "./screen.ts"
import { currentProject, sidebarView } from "./sidebar.ts"
import { shellStyles as styles } from "./styles.ts"
import { paletteId } from "./update.ts"

const loadingScreen = (h: HtmlBuilder<Message>, title: string): Screen => ({
  title,
  crumbs: [{ label: title }],
  body: h.div(
    [h.AriaBusy(true), h.AriaLabel(`Loading ${title}`), ...styleAttributes(h, styles.loading)],
    [
      h.span([...styleAttributes(h, styles.skeleton, styles.skeletonTitle)], []),
      h.span([...styleAttributes(h, styles.skeleton, styles.skeletonWide)], []),
      h.span([...styleAttributes(h, styles.skeleton, styles.skeletonShort)], []),
    ],
  ),
})

const withPage = <Tag extends PageData["_tag"]>(
  h: HtmlBuilder<Message>,
  model: Model,
  input: Readonly<{
    tag: Tag
    title: string
    render: (page: Extract<PageData, { readonly _tag: Tag }>) => Screen
  }>,
): Screen =>
  Option.match(pageOf(input.tag)(model), {
    onNone: () =>
      model.loading ? loadingScreen(h, input.title) : notFoundScreen({ h, model, page: undefined }),
    onSome: input.render,
  })

const projectView = (h: HtmlBuilder<Message>, model: Model): Screen =>
  Option.match(pageOf("EmptyProjectPage")(model), {
    onSome: (page) => emptyProjectScreen({ h, model, page }),
    onNone: () =>
      withPage(h, model, {
        tag: "OverviewPage",
        title: "Overview",
        render: (page) => overviewScreen({ h, model, page }),
      }),
  })

const screenFor = (h: HtmlBuilder<Message>, model: Model): Screen =>
  Option.match(model.pageError, {
    onNone: () => routeScreen(h, model),
    onSome: (error) =>
      isAuthRoute(model.route) ? routeScreen(h, model) : failureScreen({ h, error }),
  })

const routeScreen = (h: HtmlBuilder<Message>, model: Model): Screen =>
  AppRoute.match(model.route, {
    SignIn: () => authScreen({ h, model, page: undefined }),
    SignUp: () => authScreen({ h, model, page: undefined }),
    VerifyEmail: () => authScreen({ h, model, page: undefined }),
    ForgotPassword: () => authScreen({ h, model, page: undefined }),
    ResetPassword: () => authScreen({ h, model, page: undefined }),
    AcceptInvitation: () => authScreen({ h, model, page: undefined }),
    Onboarding: () => authScreen({ h, model, page: undefined }),
    Overview: () => projectView(h, model),
    Project: () => projectView(h, model),
    Actors: () =>
      withPage(h, model, {
        tag: "ActorsPage",
        title: "Actors",
        render: (page) => actorsScreen({ h, model, page }),
      }),
    ActorType: () =>
      withPage(h, model, {
        tag: "ActorTypePage",
        title: "Actors",
        render: (page) => actorTypeScreen({ h, model, page }),
      }),
    Actor: () =>
      Option.match(pageOf("MissingActorPage")(model), {
        onSome: (page) => missingActorScreen({ h, model, page }),
        onNone: () =>
          withPage(h, model, {
            tag: "ActorPage",
            title: "Actor",
            render: (page) => actorScreen({ h, model, page }),
          }),
      }),
    Commands: () =>
      withPage(h, model, {
        tag: "CommandsPage",
        title: "Commands",
        render: (page) => commandsScreen({ h, model, page }),
      }),
    Jobs: () =>
      withPage(h, model, {
        tag: "JobsPage",
        title: "Jobs",
        render: (page) => jobsScreen({ h, model, page }),
      }),
    Workflows: () =>
      withPage(h, model, {
        tag: "WorkflowsPage",
        title: "Workflows",
        render: (page) => workflowsScreen({ h, model, page }),
      }),
    Connections: () =>
      withPage(h, model, {
        tag: "ConnectionsPage",
        title: "Connections",
        render: (page) => connectionsScreen({ h, model, page }),
      }),
    Deployments: () =>
      withPage(h, model, {
        tag: "DeploymentsPage",
        title: "Deployments",
        render: (page) => deploymentsScreen({ h, model, page }),
      }),
    Deployment: () =>
      withPage(h, model, {
        tag: "DeploymentPage",
        title: "Deployment",
        render: (page) => deploymentScreen({ h, model, page }),
      }),
    Regions: () =>
      withPage(h, model, {
        tag: "RegionsPage",
        title: "Regions & database",
        render: (page) => regionsScreen({ h, model, page }),
      }),
    SettingsGeneral: () => settingsView(h, model),
    SettingsAppearance: () => settingsView(h, model),
    SettingsProfile: () => settingsView(h, model),
    SettingsNotifications: () => settingsView(h, model),
    SettingsEnvironment: () => settingsView(h, model),
    SettingsRegions: () => settingsView(h, model),
    SettingsDomains: () => settingsView(h, model),
    SettingsKeys: () => settingsView(h, model),
    SettingsIntegrations: () => settingsView(h, model),
    SettingsOrganization: () => settingsView(h, model),
    SettingsMembers: () => settingsView(h, model),
    SettingsBilling: () => settingsView(h, model),
    SettingsUsage: () => settingsView(h, model),
    SettingsAudit: () => settingsView(h, model),
    NotFound: () => notFoundScreen({ h, model, page: undefined }),
  })

const settingsView = (h: HtmlBuilder<Message>, model: Model): Screen =>
  withPage(h, model, {
    tag: "SettingsPage",
    title: "Settings",
    render: (page) => settingsScreen({ h, model, page }),
  })

const overlays = (h: HtmlBuilder<Message>, model: Model): ReadonlyArray<Html> => {
  const results = paletteResults(model)
  return [
    commandPalette(h, {
      id: paletteId,
      open: model.palette.open,
      query: model.palette.query,
      items: results,
      activeId: model.palette.active ?? results[0]?.id,
      onQuery: (query) => ChangedPaletteQuery({ query }),
      onMove: (step) => MovedPaletteSelection({ step }),
      onHighlight: (id) => HighlightedPaletteItem({ id }),
      onChoose: ChosePaletteItem(),
      onClose: ClosedPalette(),
    }),
    dialogView({ h, model }),
    toaster(h, { toasts: model.toasts, onDismiss: (id) => DismissedToast({ id }) }),
  ]
}

const render = (model: Model, h: HtmlBuilder<Message>): Document => {
  const screen = screenFor(h, model)
  const title = `${screen.title} · Akter`
  const notice =
    model.pageSample && !model.loading
      ? h.div(
          [...styleAttributes(h, styles.sampleNotice)],
          [
            settingsRow(h, {
              label: "Sample data — this page isn’t connected yet.",
              attributes: [h.Role("note"), h.DataAttribute("slot", "sample-notice")],
            }),
          ],
        )
      : h.empty
  if (isAuthRoute(model.route))
    return {
      title,
      body: h.div(
        [...styleAttributes(h, styles.root)],
        [
          notice,
          model.pageSample
            ? h.fieldset(
                [h.Disabled(true), ...styleAttributes(h, styles.sampleForm)],
                [screen.body],
              )
            : screen.body,
          ...overlays(h, model),
        ],
      ),
    }
  const settings = isSettingsRoute(model.route)
  const menu = h.span(
    [...styleAttributes(h, styles.narrowOnly)],
    [
      iconButton(h, {
        label: "Open navigation",
        icon: "menu",
        onClick: ToggledDrawer(),
        pressed: model.drawer,
        tooltip: "none",
        attributes: [h.AriaControls("navigation"), h.AriaExpanded(model.drawer)],
      }),
    ],
  )
  const bar = topBar(h, {
    leading: menu,
    crumbs: settings
      ? screen.crumbs
      : [{ label: currentProject(model), href: "/" }, ...screen.crumbs],
    actions: screen.actions,
  })
  return {
    title,
    body: h.div(
      [...styleAttributes(h, styles.root)],
      [
        appFrame(h, {
          sidebar: sidebarView({ h, model }),
          drawerOpen: model.drawer,
          onCloseDrawer: ClosedDrawer(),
          mainLabel: screen.title,
          main: [
            settings ? h.div([...styleAttributes(h, styles.settingsBar)], [bar]) : bar,
            notice,
            screen.body,
          ],
        }),
        ...overlays(h, model),
      ],
    ),
  }
}

/** The whole console: the frame for the route, its page, and the palette, dialog and toasts. */
export const view: {
  (model: Model, h: HtmlBuilder<Message>): Document
  (h: HtmlBuilder<Message>): (model: Model) => Document
} = Function.dual(2, render)
