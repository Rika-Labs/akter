import { Effect } from "effect"
import { cloud, type ConsoleError, load, projectContext } from "../api/client.ts"
import { toConnectionsPage } from "./mapping.ts"
import type { ConnectionsPage } from "./model.ts"

/** Loads live connection counts. */
export const loadConnections: Effect.Effect<ConnectionsPage, ConsoleError> = load(
  Effect.gen(function* () {
    const api = yield* cloud
    const { project, environment } = yield* projectContext
    const summary = yield* api.runtime.getConnections({
      params: { projectId: project.id, environment },
    })
    return toConnectionsPage(summary)
  }),
  () => import("./fixtures.ts").then((fixtures) => fixtures.connections),
)
