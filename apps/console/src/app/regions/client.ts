import { DateTime, Effect } from "effect"
import { type ConsoleError, type Loaded, withProject } from "../api/client.ts"
import { toRegionsPage } from "./mapping.ts"
import type { RegionsPage } from "./model.ts"

/** Loads the environment's regions and their databases. */
export const loadRegions: Effect.Effect<Loaded<RegionsPage>, ConsoleError> = withProject(
  (api, { project, environment }) =>
    Effect.gen(function* () {
      const regions = yield* api.regions.list({ params: { projectId: project.id, environment } })
      return toRegionsPage(yield* DateTime.now)(regions)
    }),
  () => import("./fixtures.ts").then((fixtures) => fixtures.regions),
)
