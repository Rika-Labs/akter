import { DateTime, Effect } from "effect"
import { cloud, type ConsoleError, load, projectContext } from "../api/client.ts"
import { toRegionsPage } from "./mapping.ts"
import type { RegionsPage } from "./model.ts"

/** Loads the environment's regions and their databases. */
export const loadRegions: Effect.Effect<RegionsPage, ConsoleError> = load(
  Effect.gen(function* () {
    const api = yield* cloud
    const { project, environment } = yield* projectContext
    const regions = yield* api.regions.list({ params: { projectId: project.id, environment } })
    return toRegionsPage(yield* DateTime.now)(regions)
  }),
  () => import("./fixtures.ts").then((fixtures) => fixtures.regions),
)
