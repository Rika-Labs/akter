import { DeploymentId } from "@akter/cloud-api"
import type { DeploymentSummary } from "@akter/cloud-api"
import { DateTime, Effect, Schema } from "effect"
import {
  cloud,
  ConsoleError,
  consoleError,
  fixturesEnabled,
  type Loaded,
  projectContext,
  withProject,
} from "../api/client.ts"
import { orUndefined } from "../overview/absent.ts"
import { toDeploymentPage, toDeploymentsPage } from "./mapping.ts"
import type { DeploymentPage, DeploymentsPage } from "./model.ts"

interface Page {
  readonly items: ReadonlyArray<DeploymentSummary>
  readonly nextCursor: string | null
}

const maxDetailPages = 100

/** Loads the newest deploys of the current environment. */
export const loadDeployments: Effect.Effect<Loaded<DeploymentsPage>, ConsoleError> = withProject(
  (api, { project, environment }) =>
    Effect.gen(function* () {
      const page = yield* api.deployments.list({
        params: { projectId: project.id },
        query: { environment, limit: 50 },
      })
      return toDeploymentsPage(yield* DateTime.now)({ environment, summaries: page.items })
    }),
  () => import("./fixtures.ts").then((fixtures) => fixtures.deploymentsPage),
)

/**
 * Loads one deploy by its abbreviated or full commit, or nothing for a commit that was never
 * deployed. The history is paged newest first, so the search stops at the page that holds the
 * commit. A cursor the server repeats or a history longer than `maxDetailPages` pages fails with
 * an `InvalidResponse` `ConsoleError` instead of looping.
 */
export const loadDeployment = (
  commit: string,
): Effect.Effect<Loaded<DeploymentPage | undefined>, ConsoleError> =>
  withProject(
    (api, { project, environment }) =>
      Effect.gen(function* () {
        const params = { projectId: project.id }
        const seen = new Set<string>()
        let cursor: string | undefined = undefined
        for (let pages = 0; pages < maxDetailPages; pages++) {
          const page: Page = yield* api.deployments.list({
            params,
            query: { environment, limit: 100, cursor },
          })
          const hit = page.items.find(
            (item) => item.commitSha.startsWith(commit) || commit.startsWith(item.commitSha),
          )
          if (hit !== undefined) {
            const detail = yield* api.deployments.get({
              params: { ...params, deploymentId: hit.id },
            })
            const log = yield* api.deployments.getBuildLog({
              params: { ...params, deploymentId: hit.id },
              query: {},
            })
            return toDeploymentPage(yield* DateTime.now)({ detail, log })
          }
          if (page.nextCursor === null) return undefined
          if (seen.has(page.nextCursor))
            return yield* ConsoleError.make({
              kind: "InvalidResponse",
              message: "The deployment history repeated a page cursor.",
            })
          seen.add(page.nextCursor)
          cursor = page.nextCursor
        }
        return yield* ConsoleError.make({
          kind: "InvalidResponse",
          message: "The deployment history is longer than the console can search.",
        })
      }).pipe(orUndefined),
    () => import("./fixtures.ts").then((fixtures) => fixtures.deploymentPage(commit)),
  )

/**
 * Rolls back through the deployment with `id`. Fixture mode attempts nothing and fails with a
 * `Sample` `ConsoleError`, and a refusal (including an endpoint that is not implemented) surfaces
 * as a `ConsoleError` instead of a fake success.
 */
export const rollBackDeployment = (id: string): Effect.Effect<void, ConsoleError> =>
  Effect.suspend(() =>
    fixturesEnabled()
      ? Effect.fail(ConsoleError.make({ kind: "Sample", message: "Sample data can’t be changed." }))
      : Effect.gen(function* () {
          const api = yield* cloud
          const { project } = yield* projectContext
          const deploymentId = yield* Schema.decodeEffect(DeploymentId)(id)
          yield* api.deployments.rollback({ params: { projectId: project.id, deploymentId } })
        }).pipe(Effect.mapError(consoleError)),
  )
