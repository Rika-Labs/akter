import { NotFound } from "@akter/cloud-api"
import { DateTime, Effect, Schema } from "effect"
import {
  cloud,
  type ConsoleError,
  consoleError,
  fixturesEnabled,
  type Loaded,
  load,
  projectContext,
  selectedWindow,
  withProject,
} from "../api/client.ts"
import { orUndefined } from "../overview/absent.ts"
import { flattenLoaded, sourced } from "../overview/partial.ts"
import { toActorInstance, toActorPage, toTypeActivity } from "./mapping.ts"
import { type ActorPage, ActorTypePage, ActorsPage, MissingActorPage } from "./model.ts"

/** The longest prefix the search endpoint accepts. */
const searchLength = 256

/**
 * The addresses of actors in the selected environment whose address starts with `prefix`. The
 * palette offers them as a convenience, so sample data searches nothing and a search that fails
 * for any reason finds nothing instead of interrupting what the person is typing.
 */
export const searchActors = (prefix: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.suspend(() => {
    const q = prefix.trim().slice(0, searchLength)
    if (fixturesEnabled() || q === "") return Effect.succeed([])
    return Effect.gen(function* () {
      const api = yield* cloud
      const { project, environment } = yield* projectContext
      const found = yield* api.runtime.search({
        params: { projectId: project.id, environment },
        query: { q },
      })
      return found.flatMap((result) => (result.kind === "actor" ? [result.id] : []))
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
  })

/** Loads the project's actor types. */
export const loadActors: Effect.Effect<Loaded<ActorsPage>, ConsoleError> = withProject(
  (api, { project, environment }) =>
    Effect.gen(function* () {
      const types = yield* api.runtime.listActorTypes({
        params: { projectId: project.id, environment },
      })
      return ActorsPage.make({ types })
    }),
  () => import("./fixtures.ts").then((fixtures) => fixtures.actorsPage),
)

/**
 * Loads one actor type, its activity over the selected window and the first page of its instances,
 * or nothing when there is no such type. When only the activity endpoint is not implemented, the
 * summary and instances stay live, so the page does too, and only its activity is marked sample.
 */
export const loadActorType = (
  name: string,
): Effect.Effect<Loaded<ActorTypePage | undefined>, ConsoleError> =>
  Effect.suspend(() => {
    const window = selectedWindow()
    return withProject(
      (api, { project, environment }) =>
        Effect.gen(function* () {
          const params = { projectId: project.id, environment, actorType: name }
          const summary = yield* api.runtime.getActorType({ params })
          const instances = yield* api.runtime.listActorInstances({ params, query: { limit: 50 } })
          const activity = yield* load(
            api.runtime
              .getActorTypeActivity({ params, query: { window } })
              .pipe(Effect.map(toTypeActivity)),
            () =>
              import("./fixtures.ts").then((fixtures) => fixtures.typeActivity(window)(summary)),
          )
          const now = yield* DateTime.now
          return sourced(
            ActorTypePage.make({
              commandScope: { projectId: project.id, environment },
              summary,
              instances: instances.items.map(toActorInstance(now)),
              activity: activity.data,
              activitySample: activity.sample,
            }),
            false,
          )
        }).pipe(
          orUndefined,
          Effect.map(
            (found): Loaded<ActorTypePage | undefined> => found ?? sourced(undefined, false),
          ),
        ),
      () =>
        import("./fixtures.ts").then((fixtures) =>
          sourced(fixtures.actorTypePage(window)(name), true),
        ),
    ).pipe(Effect.map(flattenLoaded))
  })

/**
 * Loads one actor for the inspector. An address the runtime reports as no actor at all has simply
 * never received a command, so it loads as a `MissingActorPage` that can send the first one; any
 * other missing resource, such as an environment with no live deployment, is nothing. When the
 * runtime cannot inspect actors yet, its job list still proves the actor exists: the page then
 * shows those live jobs and keeps the real command scope, so commands can be sent, while the rest
 * of the inspector is sample data. Only when the job list is unavailable too does the whole page
 * fall back to the fixture.
 */
export const loadActor = (
  input: Readonly<{ actorType: string; key: string }>,
): Effect.Effect<Loaded<ActorPage | MissingActorPage | undefined>, ConsoleError> =>
  withProject(
    (api, { project, environment }) => {
      const params = { projectId: project.id, environment, ...input }
      const commandScope = { projectId: project.id, environment }
      return api.runtime.inspectActor({ params }).pipe(
        Effect.map((inspector) => sourced({ ...toActorPage(inspector), commandScope }, false)),
        Effect.catchTag("NotImplemented", (uninspectable) =>
          api.runtime.listActorJobs({ params }).pipe(
            Effect.catchTag("NotImplemented", () => Effect.fail(uninspectable)),
            Effect.flatMap((jobs) =>
              Effect.tryPromise({
                try: () => import("./fixtures.ts"),
                catch: consoleError,
              }).pipe(
                Effect.map((fixtures) =>
                  sourced({ ...fixtures.sampleActor(input), jobs, commandScope }, true),
                ),
              ),
            ),
          ),
        ),
        Effect.catchIf(
          (error) => Schema.is(NotFound)(error) && error.resource === "actor",
          () =>
            Effect.succeed(
              sourced<ActorPage | MissingActorPage>(
                MissingActorPage.make({ ...input, commandScope }),
                false,
              ),
            ),
        ),
        orUndefined,
        Effect.map(
          (found): Loaded<ActorPage | MissingActorPage | undefined> =>
            found ?? sourced(undefined, false),
        ),
      )
    },
    () => import("./fixtures.ts").then((fixtures) => sourced(fixtures.actorPage(input), true)),
  ).pipe(Effect.map(flattenLoaded))
