import { DateTime, Effect, Option } from "effect"
import { type ConsoleError, type Loaded, load, selectedWindow, withProject } from "../api/client.ts"
import { organizationCap } from "../quota/client.ts"
import { toLatencyDistribution, toOverviewPage } from "./mapping.ts"
import { EmptyProjectPage, type OverviewPage } from "./model.ts"
import { flattenLoaded, sourced } from "./partial.ts"

const loadSelected = (fixture: () => Promise<OverviewPage | EmptyProjectPage>) =>
  withProject(
    (api, { project, environment }) =>
      Effect.gen(function* () {
        if (project.status === "empty")
          return sourced<OverviewPage | EmptyProjectPage>(
            EmptyProjectPage.make({ project: project.slug, region: project.homeRegion }),
            false,
          )
        const window = selectedWindow()
        const overview = yield* api.runtime.getOverview({
          params: { projectId: project.id, environment },
        })
        const distribution = yield* load(
          Effect.gen(function* () {
            const types = yield* api.runtime.listActorTypes({
              params: { projectId: project.id, environment },
            })
            const latencies = yield* Effect.forEach(
              types,
              (type) =>
                api.runtime.getActorTypeLatency({
                  params: { projectId: project.id, environment, actorType: type.name },
                  query: { window },
                }),
              { concurrency: 4 },
            )
            return toLatencyDistribution(window)(latencies)
          }),
          () => import("./fixtures.ts").then((fixtures) => fixtures.distribution(window)),
        )
        return sourced<OverviewPage | EmptyProjectPage>(
          toOverviewPage(yield* DateTime.now)({
            project: project.slug,
            overview,
            distribution: distribution.data,
          }),
          distribution.sample,
        )
      }),
    () => fixture().then((data) => sourced(data, true)),
  ).pipe(
    Effect.map(flattenLoaded),
    Effect.zipWith(
      organizationCap,
      (loaded, cap) =>
        Option.match(cap, {
          onNone: () => loaded,
          onSome: (reached) => ({ ...loaded, data: { ...loaded.data, cap: reached } }),
        }),
      { concurrent: true },
    ),
  )

/** Loads the selected project's overview, or the empty state when it has never been deployed. */
export const loadOverview: Effect.Effect<
  Loaded<OverviewPage | EmptyProjectPage>,
  ConsoleError
> = Effect.suspend(() =>
  loadSelected(() =>
    import("./fixtures.ts").then((fixtures) => fixtures.overviewFor(selectedWindow())),
  ),
)

/**
 * Loads a project by slug: the overview when it has been deployed, the empty state otherwise. The
 * project context resolves the slug from the URL.
 */
export const loadProject = (
  slug: string,
): Effect.Effect<Loaded<OverviewPage | EmptyProjectPage>, ConsoleError> =>
  Effect.suspend(() =>
    loadSelected(() =>
      import("./fixtures.ts").then((fixtures) => fixtures.projectPage(slug, selectedWindow())),
    ),
  )
