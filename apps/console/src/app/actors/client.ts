import { DateTime, Effect } from "effect"
import { cloud, type ConsoleError, load, projectContext } from "../api/client.ts"
import { orUndefined } from "../overview/absent.ts"
import { toActorInstance, toActorPage } from "./mapping.ts"
import { type ActorPage, ActorTypePage, ActorsPage } from "./model.ts"

/** Loads the project's actor types. */
export const loadActors: Effect.Effect<ActorsPage, ConsoleError> = load(
  Effect.gen(function* () {
    const api = yield* cloud
    const { project, environment } = yield* projectContext
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
): Effect.Effect<ActorTypePage | undefined, ConsoleError> =>
  load(
    Effect.gen(function* () {
      const api = yield* cloud
      const { project, environment } = yield* projectContext
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
): Effect.Effect<ActorPage | undefined, ConsoleError> =>
  load(
    Effect.gen(function* () {
      const api = yield* cloud
      const { project, environment } = yield* projectContext
      const inspector = yield* api.runtime.inspectActor({
        params: { projectId: project.id, environment, ...input },
      })
      return toActorPage(inspector)
    }).pipe(orUndefined),
    () => import("./fixtures.ts").then((fixtures) => fixtures.actorPage(input)),
  )
