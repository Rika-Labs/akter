import { DateTime, Effect } from "effect"
import {
  type ConsoleError,
  consoleError,
  type Loaded,
  load,
  selectedWindow,
  withProject,
} from "../api/client.ts"
import { orUndefined } from "../overview/absent.ts"
import { flattenLoaded, sourced } from "../overview/partial.ts"
import { toActorInstance, toActorPage, toTypeActivity } from "./mapping.ts"
import { type ActorPage, ActorTypePage, ActorsPage } from "./model.ts"

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
 * summary and instances stay live and the page is marked sample.
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
          return {
            data: ActorTypePage.make({
              commandScope: { projectId: project.id, environment },
              summary,
              instances: instances.items.map(toActorInstance(now)),
              activity: activity.data,
            }),
            sample: activity.sample,
          }
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
 * Loads one actor for the inspector, or nothing when there is no such actor. When the runtime
 * cannot inspect actors yet, its job list still proves the actor exists: the page then shows those
 * live jobs and keeps the real command scope, so commands can be sent, while the rest of the
 * inspector is sample data. Only when the job list is unavailable too does the whole page fall
 * back to the fixture.
 */
export const loadActor = (
  input: Readonly<{ actorType: string; key: string }>,
): Effect.Effect<Loaded<ActorPage | undefined>, ConsoleError> =>
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
        orUndefined,
        Effect.map((found): Loaded<ActorPage | undefined> => found ?? sourced(undefined, false)),
      )
    },
    () => import("./fixtures.ts").then((fixtures) => sourced(fixtures.actorPage(input), true)),
  ).pipe(Effect.map(flattenLoaded))
