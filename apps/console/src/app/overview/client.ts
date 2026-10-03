import { DateTime, Effect } from "effect"
import { type ConsoleError, type Loaded, withProject } from "../api/client.ts"
import { toOverviewPage } from "./mapping.ts"
import { EmptyProjectPage, type OverviewPage } from "./model.ts"

const loadSelected = (fixture: () => Promise<OverviewPage | EmptyProjectPage>) =>
  withProject(
    (api, { project, environment }) =>
      Effect.gen(function* () {
        if (project.status === "empty")
          return EmptyProjectPage.make({ project: project.slug, region: project.homeRegion })
        const overview = yield* api.runtime.getOverview({
          params: { projectId: project.id, environment },
        })
        return toOverviewPage(yield* DateTime.now)({ project: project.slug, overview })
      }),
    fixture,
  )

/** Loads the selected project's overview, or the empty state when it has never been deployed. */
export const loadOverview: Effect.Effect<
  Loaded<OverviewPage | EmptyProjectPage>,
  ConsoleError
> = loadSelected(() => import("./fixtures.ts").then((fixtures) => fixtures.overview))

/**
 * Loads a project by slug: the overview when it has been deployed, the empty state otherwise. The
 * project context resolves the slug from the URL.
 */
export const loadProject = (
  slug: string,
): Effect.Effect<Loaded<OverviewPage | EmptyProjectPage>, ConsoleError> =>
  loadSelected(() => import("./fixtures.ts").then((fixtures) => fixtures.projectPage(slug)))
