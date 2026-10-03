import type { Me, PinnedActor, Project, SidebarCounts } from "@akter/cloud-api"
import { DateTime, Effect, Function, Option, Predicate, Result } from "effect"
import { cloud, consoleError, fixturesEnabled, selectedEnvironment } from "../api/client.ts"
import { auth } from "../auth/session.ts"
import type { Workspace } from "./model.ts"

/** Auth pages and first-time users have no organization or project to render yet. */
export const emptyWorkspace: Workspace = {
  person: { name: "", email: "", role: "" },
  organization: "",
  plan: "",
  projects: [],
  pinned: [],
  deadLetters: 0,
}

/** Keeps authority IDs in the API context and formats only fields the shell actually displays. */
export const workspaceFrom: {
  (
    me: Me,
    projects: ReadonlyArray<Project>,
    pins: ReadonlyArray<PinnedActor>,
    counts: SidebarCounts | undefined,
  ): Workspace
  (
    projects: ReadonlyArray<Project>,
    pins: ReadonlyArray<PinnedActor>,
    counts: SidebarCounts | undefined,
  ): (me: Me) => Workspace
} = Function.dual(
  4,
  (
    me: Me,
    projects: ReadonlyArray<Project>,
    pins: ReadonlyArray<PinnedActor>,
    counts: SidebarCounts | undefined,
  ): Workspace => {
    const membership =
      me.organizations.find((item) => item.organization.id === me.activeOrganizationId) ??
      me.organizations[0]
    return {
      person: {
        name: me.user?.name ?? "",
        email: me.user?.email ?? "",
        role: membership?.role ?? "",
      },
      organization: membership?.organization.name ?? "",
      plan: membership?.organization.plan ?? "",
      projects: projects.map((project) => ({
        slug: project.slug,
        deployed: project.status !== "empty",
        region: project.homeRegion,
      })),
      pinned: pins.map((pin) => {
        const separator = pin.address.indexOf("/")
        return {
          commandScope: { projectId: pin.projectId, environment: pin.environment },
          actorType: pin.address.slice(0, separator),
          key: pin.address.slice(separator + 1),
          awake: pin.status === "awake",
          lastTurn:
            pin.lastActivityAt === null ? "Unknown" : DateTime.formatIso(pin.lastActivityAt),
        }
      }),
      deadLetters: counts?.openDeadLetters ?? 0,
    }
  },
)

/** Runtime-only sidebar data can be absent while the control-plane identity remains usable. */
const runtimeOptional = <A, E>(effect: Effect.Effect<A, E>, empty: A) =>
  effect.pipe(Effect.catchIf(Predicate.isTagged("NotImplemented"), () => Effect.succeed(empty)))

const sessionWorkspace = auth.session.pipe(
  Effect.map((session): Workspace => ({
    ...emptyWorkspace,
    person: Option.match(session, {
      onNone: () => emptyWorkspace.person,
      onSome: (user) => ({ name: user.name, email: user.email, role: "" }),
    }),
  })),
  Effect.orElseSucceed(() => emptyWorkspace),
)

/** Signed-out bootstrap renders the auth screen; other failures stay visible without sample identities. */
export const loadWorkspace: Effect.Effect<Workspace> = Effect.suspend(() => {
  if (fixturesEnabled())
    return Effect.promise(() =>
      import("./fixtures.ts").then((module) => ({
        ...module.workspace,
        pinned: [],
        deadLetters: 0,
        person: { name: "Sample workspace", email: "", role: "" },
      })),
    )
  return Effect.gen(function* () {
    const api = yield* cloud
    const me = yield* api.account.me().pipe(Effect.catchTag("Unauthorized", () => Effect.void))
    if (me === undefined) return yield* sessionWorkspace
    const membership =
      me.organizations.find((item) => item.organization.id === me.activeOrganizationId) ??
      me.organizations[0]
    if (membership === undefined) return workspaceFrom(me, [], [], undefined)
    const projects = yield* api.projects
      .list({
        params: { organizationId: membership.organization.id },
      })
      .pipe(Effect.result)
    if (Result.isFailure(projects))
      return {
        ...workspaceFrom(me, [], [], undefined),
        error: consoleError(projects.failure).message,
      }
    const selected =
      typeof sessionStorage === "undefined" ? undefined : sessionStorage.getItem("console-project")
    const project = projects.success.find((item) => item.slug === selected) ?? projects.success[0]
    if (project === undefined) return workspaceFrom(me, projects.success, [], undefined)
    const params = { projectId: project.id, environment: selectedEnvironment() }
    const pins = yield* runtimeOptional(api.account.listPinnedActors({ query: params }), [])
    const counts = yield* runtimeOptional<
      SidebarCounts | undefined,
      Effect.Error<ReturnType<typeof api.runtime.getSidebarCounts>>
    >(api.runtime.getSidebarCounts({ params }), undefined)
    return workspaceFrom(me, projects.success, pins, counts)
  })
}).pipe(
  Effect.mapError(consoleError),
  Effect.catch((error) =>
    sessionWorkspace.pipe(Effect.map((workspace) => ({ ...workspace, error: error.message }))),
  ),
)
