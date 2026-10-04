import { DeploymentId, NotFound } from "@akter/cloud-api"
import type { DeploymentSummary, ProjectId } from "@akter/cloud-api"
import { DateTime, Effect, Option, Predicate, Schema } from "effect"
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
import {
  rollbackCandidates,
  toDeployRecord,
  toDeploymentPage,
  toDeploymentsPage,
  toRolledBack,
} from "./mapping.ts"
import type { DeployRecord, DeploymentPage, DeploymentsPage, RolledBack } from "./model.ts"

interface Page {
  readonly items: ReadonlyArray<DeploymentSummary>
  readonly nextCursor: string | null
}

const maxDetailPages = 100

/**
 * Whether a page request failed because the server no longer takes the cursor it was given: one it
 * does not recognise is `NotFound` `cursor`, and one it cannot read is answered 400. Paging then
 * starts again from the first page rather than reporting the API unreachable.
 */
const staleCursor = <E>(error: E): boolean =>
  (Schema.is(NotFound)(error) && error.resource === "cursor") ||
  Predicate.isTagged(error, "HttpApiSchemaError") ||
  (Predicate.isTagged(error, "HttpClientError") &&
    Predicate.hasProperty(error, "response") &&
    Predicate.hasProperty(error.response, "status") &&
    error.response.status === 400)

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

const commitReference = /^[0-9a-f]{7,40}$/i

/**
 * Loads one deploy by its deployment id or by its abbreviated or full commit, or nothing for a
 * reference that names no deployment. An exact id always wins: it is read directly, so an unknown
 * id is not found at once and never falls back to another deployment. Only a reference shaped like
 * a commit, in either case, is then searched for in the history, newest first, so a commit names its
 * newest deployment; a deployment without a recorded commit never matches; rollbacks and redeploys
 * reuse commits, which is why the console's own links use ids. The history of the deployment's
 * environment is also read for rollback targets: a live deploy keeps paging until an earlier
 * deployment it could roll back to turns up or the history ends, stopping quietly at
 * `maxDetailPages`. A cursor the server no longer takes starts the search over from the first page
 * once. A second one ends it: with the history read so far when the deployment was found, and
 * otherwise with an `IncompleteHistory` `ConsoleError` asking to try again, since the deployment
 * may well exist. A cursor the server repeats, or a history longer than `maxDetailPages` pages that
 * never holds the commit, fails with an `InvalidResponse` `ConsoleError` instead of looping.
 */
export const loadDeployment = (
  reference: string,
): Effect.Effect<Loaded<DeploymentPage | undefined>, ConsoleError> =>
  withProject(
    (api, { project, environment }) =>
      Effect.gen(function* () {
        const params = { projectId: project.id }
        const named = Schema.decodeOption(DeploymentId)(reference)
        const byId = Option.isNone(named)
          ? undefined
          : yield* api.deployments
              .get({ params: { ...params, deploymentId: named.value } })
              .pipe(orUndefined)
        if (byId === undefined && !commitReference.test(reference)) return undefined
        const commit = reference.toLowerCase()
        const seen = new Set<string>()
        const history: Array<DeploymentSummary> = []
        let hit: DeploymentSummary | undefined = byId
        let cursor: string | undefined = undefined
        let restarted = false
        for (let pages = 0; pages < maxDetailPages; pages++) {
          const read: Option.Option<Page> = yield* api.deployments
            .list({
              params,
              query: { environment: byId?.environment ?? environment, limit: 100, cursor },
            })
            .pipe(
              Effect.asSome,
              Effect.catchIf(
                (error) => cursor !== undefined && staleCursor(error),
                () => Effect.succeedNone,
              ),
            )
          if (Option.isNone(read)) {
            if (restarted) {
              if (hit === undefined)
                return yield* ConsoleError.make({
                  kind: "IncompleteHistory",
                  message: "Couldn’t finish searching the deployment history. Try again.",
                })
              break
            }
            restarted = true
            cursor = undefined
            seen.clear()
            history.length = 0
            hit = byId
            continue
          }
          const page: Page = read.value
          history.push(...page.items)
          hit ??= page.items.find(
            (item) =>
              item.commitSha !== "" &&
              (item.commitSha.startsWith(commit) || commit.startsWith(item.commitSha)),
          )
          if (
            hit !== undefined &&
            (page.nextCursor === null ||
              hit.status !== "live" ||
              rollbackCandidates(hit)(history).length > 0)
          )
            break
          if (page.nextCursor === null) return undefined
          if (seen.has(page.nextCursor))
            return yield* ConsoleError.make({
              kind: "InvalidResponse",
              message: "The deployment history repeated a page cursor.",
            })
          seen.add(page.nextCursor)
          cursor = page.nextCursor
        }
        if (hit === undefined)
          return yield* ConsoleError.make({
            kind: "InvalidResponse",
            message: "The deployment history is longer than the console can search.",
          })
        const deploymentId = hit.id
        const detail = byId ?? (yield* api.deployments.get({ params: { ...params, deploymentId } }))
        const log = yield* api.deployments.getBuildLog({
          params: { ...params, deploymentId },
          query: {},
        })
        return toDeploymentPage(yield* DateTime.now)({ detail, log, history })
      }).pipe(orUndefined),
    () => import("./fixtures.ts").then((fixtures) => fixtures.deploymentPage(reference)),
  )

/**
 * Runs one change against the deployment with `id` in the current project. Fixture mode attempts
 * nothing, so a sample page can never report a change as made.
 */
const changeDeployment = <A, E>(
  run: (
    api: Effect.Success<typeof cloud>,
    params: Readonly<{ projectId: ProjectId; deploymentId: DeploymentId }>,
  ) => Effect.Effect<A, E>,
  id: string,
): Effect.Effect<A, ConsoleError> =>
  Effect.suspend(() =>
    fixturesEnabled()
      ? Effect.fail(ConsoleError.make({ kind: "Sample", message: "Sample data can’t be changed." }))
      : Effect.gen(function* () {
          const api = yield* cloud
          const { project } = yield* projectContext
          const deploymentId = yield* Schema.decodeEffect(DeploymentId)(id)
          return yield* run(api, { projectId: project.id, deploymentId })
        }).pipe(Effect.mapError(consoleError)),
  )

/**
 * Rolls the environment back to the earlier deployment with `id`, which names the target to
 * restore and not the deployment being viewed, and returns the new deployment the server created
 * with its `rolledBackFrom` reference. Fixture mode attempts nothing and fails with a `Sample`
 * `ConsoleError`, and a refusal (a target that is not restorable, a rollout already in progress, or
 * an endpoint that is not implemented) surfaces as a `ConsoleError` instead of a fake success.
 */
export const rollBackDeployment = (id: string): Effect.Effect<RolledBack, ConsoleError> =>
  changeDeployment(
    (api, params) =>
      Effect.flatMap(api.deployments.rollback({ params }), (created) =>
        Effect.map(DateTime.now, (now) => toRolledBack(now)(created)),
      ),
    id,
  )

/**
 * Starts a new deployment of the commit of the deployment with `id`, which is built again before it
 * rolls out, and returns the new deployment. Like a rollback it never pretends to succeed: fixture
 * mode attempts nothing and a refusal, such as a rollout already in progress, is a `ConsoleError`.
 */
export const redeployDeployment = (id: string): Effect.Effect<DeployRecord, ConsoleError> =>
  changeDeployment(
    (api, params) =>
      Effect.flatMap(api.deployments.redeploy({ params }), (created) =>
        Effect.map(DateTime.now, (now) => toDeployRecord(now)(created)),
      ),
    id,
  )
