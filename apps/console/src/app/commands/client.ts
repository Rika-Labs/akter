import { Effect } from "effect"
import { type ConsoleError, type Loaded, withProject } from "../api/client.ts"
import { tailCapacity, toRecentTurns } from "./mapping.ts"
import { CommandsPage } from "./model.ts"

/** Loads the actor types the filter offers and the turns committed just before the page opened. */
export const loadCommands: Effect.Effect<Loaded<CommandsPage>, ConsoleError> = withProject(
  (api, { project, environment }) =>
    Effect.gen(function* () {
      const params = { projectId: project.id, environment }
      const types = yield* api.runtime.listActorTypes({ params })
      const recent = yield* api.runtime.listCommands({ params, query: { limit: tailCapacity } })
      return CommandsPage.make({
        types: types.map((type) => type.name),
        recent: toRecentTurns(recent.items),
      })
    }),
  () => import("./fixtures.ts").then((fixtures) => fixtures.commandsPage),
)
