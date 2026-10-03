import { Effect } from "effect"
import { type ConsoleError, type Loaded, withProject } from "../api/client.ts"
import { toConnectionsPage } from "./mapping.ts"
import type { ConnectionsPage } from "./model.ts"

/** Loads live connection counts. */
export const loadConnections: Effect.Effect<Loaded<ConnectionsPage>, ConsoleError> = withProject(
  (api, { project, environment }) =>
    api.runtime
      .getConnections({ params: { projectId: project.id, environment } })
      .pipe(Effect.map(toConnectionsPage)),
  () => import("./fixtures.ts").then((fixtures) => fixtures.connections),
)
