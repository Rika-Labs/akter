import { DeploymentId } from "@akter/cloud-api"
import type { DeploymentSummary } from "@akter/cloud-api"
import { DateTime, Effect, Schema } from "effect"
import {
  cloud,
  type ConsoleError,
  consoleError,
  fixturesEnabled,
  load,
  projectContext,
} from "../api/client.ts"
import { orUndefined } from "../overview/absent.ts"
import { toDeploymentPage, toDeploymentsPage } from "./mapping.ts"
import type { DeploymentPage, DeploymentsPage } from "./model.ts"

interface Page {
  readonly items: ReadonlyArray<DeploymentSummary>
  readonly nextCursor: string | null
}

/** Loads the newest deploys of the current environment. */
export const loadDeployments: Effect.Effect<DeploymentsPage, ConsoleError> = load(
  Effect.gen(function* () {
    const api = yield* cloud
    const { project, environment } = yield* projectContext
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
 * commit.
 */
export const loadDeployment = (
  commit: string,
): Effect.Effect<DeploymentPage | undefined, ConsoleError> =>
  load(
    Effect.gen(function* () {
      const api = yield* cloud
      const { project, environment } = yield* projectContext
      const params = { projectId: project.id }
      let cursor: string | undefined = undefined
      for (;;) {
        const page: Page = yield* api.deployments.list({
          params,
          query: { environment, limit: 100, cursor },
        })
        const hit = page.items.find(
          (item) => item.commitSha.startsWith(commit) || commit.startsWith(item.commitSha),
        )
        if (hit !== undefined) {
          const detail = yield* api.deployments.get({ params: { ...params, deploymentId: hit.id } })
          const log = yield* api.deployments.getBuildLog({
            params: { ...params, deploymentId: hit.id },
            query: {},
          })
          return toDeploymentPage(yield* DateTime.now)({
            detail,
            log,
          })
        }
        if (page.nextCursor === null) return undefined
        cursor = page.nextCursor
      }
    }).pipe(orUndefined),
    () => import("./fixtures.ts").then((fixtures) => fixtures.deploymentPage(commit)),
  )

/**
 * Rolls back through the deployment with `id`. Nothing is attempted in fixture mode, and a refusal
 * (including an endpoint that is not implemented) surfaces as a `ConsoleError` instead of a fake
 * success.
 */
export const rollBackDeployment = (id: string): Effect.Effect<void, ConsoleError> =>
  Effect.suspend(() =>
    fixturesEnabled()
      ? Effect.void
      : Effect.gen(function* () {
          const api = yield* cloud
          const { project } = yield* projectContext
          const deploymentId = yield* Schema.decodeEffect(DeploymentId)(id)
          yield* api.deployments.rollback({ params: { projectId: project.id, deploymentId } })
        }).pipe(Effect.mapError(consoleError)),
  )
