import { Effect } from "effect"
import { workspace } from "../workspace/fixtures.ts"
import { overview } from "./fixtures.ts"
import { EmptyProjectPage, type OverviewPage } from "./model.ts"

/** Loads the default project's overview. Fixture-backed until the metrics API exists. */
export const loadOverview: Effect.Effect<OverviewPage> = Effect.succeed(overview)

/**
 * Loads a project by slug: the overview when it has been deployed, the empty state otherwise. An
 * unknown slug is treated as a new project in the default region.
 */
export const loadProject = (slug: string): Effect.Effect<OverviewPage | EmptyProjectPage> => {
  const found = workspace.projects.find((candidate) => candidate.slug === slug)
  if (found?.deployed === true) return Effect.succeed({ ...overview, project: found.slug })
  return Effect.succeed(
    EmptyProjectPage.make({
      project: found?.slug ?? slug,
      region: found?.region ?? "us-east-1",
    }),
  )
}
