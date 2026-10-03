import * as Cloud from "@akter/cloud-api"
import {
  DeploymentLifecycle,
  DeploymentNotFound,
  lifecycleKey,
  type Environment,
  type DeploymentDetail,
} from "@akter/deployments/lifecycle"
import { Actor, Actors, System } from "@rikalabs/akter"
import { Crypto, Effect, Option, Predicate, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { HttpApiBuilder } from "effect/http-api"
import { Access } from "./access.ts"

const Cursor = Schema.fromJsonString(Schema.Struct({ at: Schema.String, id: Schema.String }))

const Snapshot = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))

/** Every actor handle is captured under the organization established by access, never by a request payload. */
export const DeploymentsLive = HttpApiBuilder.group(Cloud.CloudApi, "deployments", (handlers) =>
  Effect.gen(function* () {
    const access = yield* Access
    const sql = yield* SqlClient.SqlClient
    const detail = Effect.fnUntraced(function* (value: DeploymentDetail) {
      if (value.status !== "live")
        return yield* Schema.decodeUnknownEffect(Schema.toType(Cloud.DeploymentDetail))(value)
      const registered = yield* sql<{
        id: string
        region: "us-east-1" | "us-west-2"
        ready: boolean
      }>`SELECT provider_id AS id, region, ready FROM deployment_runner WHERE deployment_id = ${value.id} AND provider_id IS NOT NULL AND EXISTS (SELECT 1 FROM deployment_rollout WHERE id = ${value.id} AND organization_id = ${value.organizationId} AND project_id = ${value.projectId}) ORDER BY region, id`
      return yield* Schema.decodeUnknownEffect(Schema.toType(Cloud.DeploymentDetail))({
        ...value,
        runnerCount: registered.length,
        runners: registered.map((runner) => ({
          id: runner.id,
          region: runner.region,
          actorCount: null,
          cpuPercent: null,
          health: runner.ready
            ? (value.runners.find((known) => known.id === runner.id)?.health ?? "starting")
            : "unhealthy",
        })),
      })
    }, Effect.orDie)
    const random = yield* Crypto.Crypto
    const id = random.randomUUIDv4.pipe(Effect.orDie)
    const actorRuntime = yield* Effect.context<Actors>()
    const environmentOf = Effect.fn(function* (
      organizationId: string,
      projectId: string,
      deploymentId: string,
    ) {
      const [row] = yield* sql<{
        environment: Environment
      }>`SELECT environment FROM deployment_rollout WHERE organization_id = ${organizationId} AND tenant_id = ${organizationId} AND project_id = ${projectId} AND id = ${deploymentId}`.pipe(
        Effect.orDie,
      )
      if (row === undefined)
        return yield* Cloud.NotFound.make({ resource: "deployment", id: deploymentId })
      return row.environment
    })
    const actorOf = (organizationId: string, projectId: string, environment: Environment) =>
      Effect.gen(function* () {
        const caller = yield* Cloud.CurrentIdentity
        const subject = Predicate.isTagged(caller, "session")
          ? `user:${caller.userId}`
          : `api-key:${caller.keyId}`
        return yield* DeploymentLifecycle.get(lifecycleKey({ projectId, environment })).pipe(
          Actor.tenant(organizationId),
          Actor.as(System.make({ source: "process", onBehalfOf: { subject } })),
          Effect.provideContext(actorRuntime),
        )
      })
    const checkEnvironment = Effect.fn(function* (
      organizationId: string,
      projectId: string,
      environment: string,
    ) {
      const rows =
        yield* sql`SELECT 1 FROM cloud_environment WHERE organization_id = ${organizationId} AND project_id = ${projectId} AND name = ${environment}`.pipe(
          Effect.orDie,
        )
      if (rows.length === 0)
        return yield* Cloud.NotFound.make({ resource: "environment", id: environment })
    })
    const author = Effect.gen(function* () {
      const caller = yield* Cloud.CurrentIdentity
      if (Predicate.isTagged(caller, "session")) {
        const [person] = yield* sql<{
          name: string
          image: string | null
        }>`SELECT name, image FROM "user" WHERE id = ${caller.userId}`.pipe(Effect.orDie)
        return { name: person?.name ?? "User", image: person?.image ?? null }
      }
      const [key] = yield* sql<{
        name: string
      }>`SELECT name FROM cloud_api_key WHERE id = ${caller.keyId}`.pipe(Effect.orDie)
      return { name: key?.name ?? "API key", image: null }
    })
    const readExpected = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.catch((error) =>
          Schema.is(DeploymentNotFound)(error)
            ? Cloud.NotFound.make({ resource: "deployment", id: error.deploymentId })
            : Effect.die(error),
        ),
      )
    const expected = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.catch((error): Effect.Effect<never, Cloud.NotFound | Cloud.Conflict> => {
          if (Schema.is(DeploymentNotFound)(error))
            return Cloud.NotFound.make({ resource: "deployment", id: error.deploymentId })
          if (
            ["RolloutInProgress", "DeploymentExists", "RollbackTargetInvalid", "NotBuilding"].some(
              (tag) => Predicate.isTagged(error, tag),
            )
          )
            return Cloud.Conflict.make({ message: "The deployment transition was refused" })
          return Effect.die(error)
        }),
      )

    return handlers
      .handle("create", ({ params, payload }) =>
        Effect.gen(function* () {
          const organizationId = yield* access.project(params.projectId, "write")
          yield* checkEnvironment(organizationId, params.projectId, payload.environment)
          if (payload.regions !== undefined && payload.regions.length !== 1)
            return yield* Cloud.Conflict.make({
              message: "A deployment must name exactly one home region",
            })
          const actor = yield* actorOf(organizationId, params.projectId, payload.environment)
          const [project] = yield* sql<{
            homeRegion: "us-east-1" | "us-west-2"
          }>`SELECT home_region AS "homeRegion" FROM cloud_project WHERE id = ${params.projectId} AND organization_id = ${organizationId}`.pipe(
            Effect.orDie,
          )
          return yield* actor
            .Create({
              deploymentId: yield* id,
              commitSha: payload.commitSha,
              message: payload.message ?? "",
              author: yield* author,
              regions: payload.regions ?? [project?.homeRegion ?? "us-east-1"],
              envSnapshot: "{}",
            })
            .pipe(expected, Effect.flatMap(detail))
        }),
      )
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const organizationId = yield* access.project(params.projectId)
          const environment = yield* environmentOf(
            organizationId,
            params.projectId,
            params.deploymentId,
          )
          return yield* (yield* actorOf(organizationId, params.projectId, environment))
            .Get({ deploymentId: params.deploymentId })
            .pipe(readExpected, Effect.flatMap(detail))
        }),
      )
      .handle("recordBuild", ({ params, payload }) =>
        Effect.gen(function* () {
          const organizationId = yield* access.project(params.projectId, "write")
          const environment = yield* environmentOf(
            organizationId,
            params.projectId,
            params.deploymentId,
          )
          const actor = yield* actorOf(organizationId, params.projectId, environment)
          const deployment = yield* actor.Get({ deploymentId: params.deploymentId }).pipe(expected)
          if (deployment.commitSha !== payload.commitSha)
            return yield* Cloud.Conflict.make({
              message: "The build commit does not match the deployment",
            })
          return yield* actor
            .RecordBuild({
              deploymentId: params.deploymentId,
              imageDigest: payload.image,
              commitSha: payload.commitSha,
              envSnapshot: yield* Schema.encodeEffect(Snapshot)(
                Object.fromEntries(
                  Object.entries(payload.environmentSnapshot).sort(([left], [right]) =>
                    left < right ? -1 : left > right ? 1 : 0,
                  ),
                ),
              ).pipe(Effect.orDie),
            })
            .pipe(expected, Effect.flatMap(detail))
        }),
      )
      .handle("rollback", ({ params }) =>
        Effect.gen(function* () {
          const organizationId = yield* access.project(params.projectId, "write")
          const environment = yield* environmentOf(
            organizationId,
            params.projectId,
            params.deploymentId,
          )
          return yield* (yield* actorOf(organizationId, params.projectId, environment))
            .Rollback({
              deploymentId: yield* id,
              target: params.deploymentId,
              message: `Rollback to ${params.deploymentId}`,
              author: yield* author,
            })
            .pipe(expected, Effect.flatMap(detail))
        }),
      )
      .handle("failBuild", ({ params, payload }) =>
        Effect.gen(function* () {
          const organizationId = yield* access.project(params.projectId, "write")
          const environment = yield* environmentOf(
            organizationId,
            params.projectId,
            params.deploymentId,
          )
          return yield* (yield* actorOf(organizationId, params.projectId, environment))
            .FailBuild({ deploymentId: params.deploymentId, reason: payload.reason })
            .pipe(expected, Effect.flatMap(detail))
        }),
      )
      .handle("redeploy", ({ params }) =>
        Effect.gen(function* () {
          const organizationId = yield* access.project(params.projectId, "write")
          const environment = yield* environmentOf(
            organizationId,
            params.projectId,
            params.deploymentId,
          )
          const actor = yield* actorOf(organizationId, params.projectId, environment)
          const source = yield* actor.Get({ deploymentId: params.deploymentId }).pipe(expected)
          return yield* actor
            .Redeploy({
              deploymentId: yield* id,
              source: params.deploymentId,
              message: `Redeploy ${params.deploymentId}`,
              author: yield* author,
              regions: source.regions,
              envSnapshot: "{}",
            })
            .pipe(expected, Effect.flatMap(detail))
        }),
      )
      .handle("getBuildLog", ({ params, query }) =>
        Effect.gen(function* () {
          const organizationId = yield* access.project(params.projectId)
          const environment = yield* environmentOf(
            organizationId,
            params.projectId,
            params.deploymentId,
          )
          return yield* (yield* actorOf(organizationId, params.projectId, environment))
            .GetBuildLog({ deploymentId: params.deploymentId, after: query.after })
            .pipe(readExpected)
        }),
      )
      .handle("list", ({ params, query }) =>
        Effect.gen(function* () {
          const organizationId = yield* access.project(params.projectId)
          const cursor =
            query.cursor === undefined
              ? Option.none()
              : Schema.decodeOption(Cursor)(Buffer.from(query.cursor, "base64url").toString("utf8"))
          if (
            query.cursor !== undefined &&
            (Option.isNone(cursor) || !Number.isFinite(Date.parse(cursor.value.at)))
          )
            return yield* Cloud.NotFound.make({ resource: "cursor", id: query.cursor })
          const after = Option.getOrUndefined(cursor)
          const limit = query.limit ?? 50
          const rows = yield* sql<{
            id: string
            environment: Environment
            createdAt: Date
          }>`SELECT id, environment, created_at AS "createdAt" FROM deployment_rollout WHERE organization_id = ${organizationId} AND tenant_id = ${organizationId} AND project_id = ${params.projectId} AND (${query.environment ?? null}::text IS NULL OR environment = ${query.environment ?? null}) AND (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null}) AND (${after?.at ?? null}::timestamptz IS NULL OR (created_at, id) < (${after?.at ?? null}::timestamptz, ${after?.id ?? ""})) ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`.pipe(
            Effect.orDie,
          )
          const page = rows.slice(0, limit)
          const items = yield* Effect.forEach(page, (row) =>
            Effect.flatMap(actorOf(organizationId, params.projectId, row.environment), (actor) =>
              actor.Get({ deploymentId: row.id }).pipe(readExpected),
            ),
          )
          const last = page.at(-1)
          return {
            items: yield* Effect.forEach(items, (item) =>
              detail(item).pipe(
                Effect.flatMap((current) =>
                  Schema.decodeEffect(Schema.toType(Cloud.DeploymentSummary))(current),
                ),
                Effect.orDie,
              ),
            ),
            nextCursor:
              rows.length > limit && last !== undefined
                ? Buffer.from(
                    yield* Schema.encodeEffect(Cursor)({
                      at: last.createdAt.toISOString(),
                      id: last.id,
                    }).pipe(Effect.orDie),
                  ).toString("base64url")
                : null,
          }
        }),
      )
  }),
)
