import { DateTime, Effect } from "effect"
import { type ConsoleError, type Loaded, withProject } from "../api/client.ts"
import { orUndefined } from "../overview/absent.ts"
import { toActorInstance, toActorPage } from "./mapping.ts"
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

/** Loads one actor type and the first page of its instances, or nothing when there is no such type. */
export const loadActorType = (
  name: string,
): Effect.Effect<Loaded<ActorTypePage | undefined>, ConsoleError> =>
  withProject(
    (api, { project, environment }) =>
      Effect.gen(function* () {
        const params = { projectId: project.id, environment, actorType: name }
        const summary = yield* api.runtime.getActorType({ params })
        const instances = yield* api.runtime.listActorInstances({ params, query: { limit: 50 } })
        const now = yield* DateTime.now
        return ActorTypePage.make({
          summary,
          instances: instances.items.map(toActorInstance(now)),
        })
      }).pipe(orUndefined),
    () => import("./fixtures.ts").then((fixtures) => fixtures.actorTypePage(name)),
  )

/** Loads one actor for the inspector, or nothing when there is no such actor. */
export const loadActor = (
  input: Readonly<{ actorType: string; key: string }>,
): Effect.Effect<Loaded<ActorPage | undefined>, ConsoleError> =>
  withProject(
    (api, { project, environment }) =>
      Effect.gen(function* () {
        const inspector = yield* api.runtime.inspectActor({
          params: { projectId: project.id, environment, ...input },
        })
        return toActorPage(inspector)
      }).pipe(orUndefined),
    () => import("./fixtures.ts").then((fixtures) => fixtures.actorPage(input)),
  )
