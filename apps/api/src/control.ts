import * as Cloud from "@akter/cloud-api"
import { Effect, Layer, Option, Predicate, Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { HttpServerRequest } from "effect/http"
import { AccountServices } from "./accounts.ts"
import type * as Repository from "./repository.ts"

const project = (value: Repository.Project) =>
  Schema.decodeUnknownEffect(Schema.toType(Cloud.Project))(value).pipe(Effect.orDie)

const environment = (value: Repository.Environment) =>
  Schema.decodeUnknownEffect(Schema.toType(Cloud.Environment))(value).pipe(Effect.orDie)

/** A pin with no live status: runtime inspection is not connected, so every actor is `unknown`. */
const pinned = (value: Repository.PinnedActor) =>
  Schema.decodeUnknownEffect(Schema.toType(Cloud.PinnedActor))({
    ...value,
    status: "unknown",
    lastActivityAt: null,
  }).pipe(Effect.orDie)

const headers = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request) => new Headers(request.headers),
)

const notFound = (resource: string, id: string) => Cloud.NotFound.make({ resource, id })

const control = Effect.gen(function* () {
  const services = yield* AccountServices
  const { access, auth, repository, sql } = services

  /**
   * Who is acting and from where, for an audit entry written by the
   * repository in the same transaction as the change. The name is the one the
   * actor has now, kept so the log still reads after a rename or revocation.
   */
  const audited = Effect.fn("Control.audited")(function* (organizationId: string) {
    const caller = yield* Cloud.CurrentIdentity
    const request = yield* HttpServerRequest.HttpServerRequest
    const ip = Option.getOrUndefined(request.remoteAddress)

    if (Predicate.isTagged(caller, "session")) {
      const [row] = yield* sql<{ readonly name: string }>`
        SELECT name FROM "user" WHERE id = ${caller.userId}
      `.pipe(Effect.orDie)

      return {
        organizationId,
        ip,
        actor: { kind: "user", id: caller.userId, name: row?.name },
      } satisfies Repository.Audited
    }

    const [row] = yield* sql<{ readonly name: string }>`
      SELECT name FROM cloud_api_key WHERE id = ${caller.keyId}
    `.pipe(Effect.orDie)

    return {
      organizationId,
      ip,
      actor: { kind: "api-key", id: caller.keyId, name: row?.name },
    } satisfies Repository.Audited
  })

  const userRow = Effect.fn("Control.user")(function* (id: string) {
    const [row] = yield* sql<{
      readonly id: string
      readonly name: string
      readonly email: string
      readonly emailVerified: boolean
      readonly image: string | null
    }>`
      SELECT id, name, email, "emailVerified", image FROM "user" WHERE id = ${id}
    `.pipe(Effect.orDie)

    return row === undefined
      ? yield* Effect.die(new Error(`Session user ${id} is missing`))
      : yield* Schema.decodeUnknownEffect(Schema.toType(Cloud.User))(row).pipe(Effect.orDie)
  })

  const refused = <A>(call: () => Promise<A>) =>
    Effect.tryPromise({
      try: call,
      catch: () => Cloud.Forbidden.make({ message: "The account operation was refused" }),
    })

  return { audited, userRow, refused, access, auth, repository, services }
})

export const ProjectsLive = HttpApiBuilder.group(Cloud.CloudApi, "projects", (handlers) =>
  Effect.gen(function* () {
    const { access, audited, repository } = yield* control

    return handlers
      .handle("list", ({ params }) =>
        Effect.gen(function* () {
          yield* access.organization(params.organizationId)

          return yield* Effect.forEach(
            yield* repository.listProjects({ organizationId: params.organizationId }),
            project,
          )
        }),
      )
      .handle("create", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* access.organization(params.organizationId, "write")

          return yield* repository
            .createProject({ ...(yield* audited(params.organizationId)), ...payload })
            .pipe(
              Effect.flatMap(project),
              Effect.catchTag("ProjectSlugTaken", ({ slug }) =>
                Cloud.Conflict.make({ message: `The slug ${slug} is already used by a project` }),
              ),
            )
        }),
      )
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const organizationId = yield* access.project(params.projectId)

          return yield* repository.getProject({ organizationId, projectId: params.projectId }).pipe(
            Effect.flatMap(project),
            Effect.catchTag("ProjectNotFound", () => notFound("project", params.projectId)),
          )
        }),
      )
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          const organizationId = yield* access.project(params.projectId, "write")

          return yield* repository
            .updateProject({
              ...(yield* audited(organizationId)),
              projectId: params.projectId,
              name: payload.name,
              slug: payload.slug,
            })
            .pipe(
              Effect.flatMap(project),
              Effect.catchTags({
                ProjectNotFound: () => notFound("project", params.projectId),
                ProjectSlugTaken: ({ slug }) =>
                  Cloud.Conflict.make({ message: `The slug ${slug} is already used by a project` }),
              }),
            )
        }),
      )
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          const organizationId = yield* access.project(params.projectId, "admin")

          yield* repository
            .deleteProject({ ...(yield* audited(organizationId)), projectId: params.projectId })
            .pipe(
              Effect.catchTags({
                ProjectNotFound: () => notFound("project", params.projectId),
                ProjectInUse: () =>
                  Cloud.Conflict.make({ message: "Remove the project's deployments first" }),
              }),
            )
        }),
      )
      .handle("listEnvironments", ({ params }) =>
        Effect.gen(function* () {
          const organizationId = yield* access.project(params.projectId)

          return yield* repository
            .listEnvironments({ organizationId, projectId: params.projectId })
            .pipe(
              Effect.flatMap(Effect.forEach(environment)),
              Effect.catchTag("ProjectNotFound", () => notFound("project", params.projectId)),
            )
        }),
      )
      .handle("createEnvironment", ({ params, payload }) =>
        Effect.gen(function* () {
          const organizationId = yield* access.project(params.projectId, "admin")

          return yield* repository
            .createEnvironment({
              ...(yield* audited(organizationId)),
              projectId: params.projectId,
              name: payload.name,
            })
            .pipe(
              Effect.flatMap(environment),
              Effect.catchTags({
                ProjectNotFound: () => notFound("project", params.projectId),
                EnvironmentNameTaken: ({ name }) =>
                  Cloud.Conflict.make({ message: `The project already has a ${name} environment` }),
              }),
            )
        }),
      )
      .handle("getEnvironment", ({ params }) =>
        Effect.gen(function* () {
          const organizationId = yield* access.project(params.projectId)

          return yield* repository
            .getEnvironment({
              organizationId,
              projectId: params.projectId,
              name: params.environment,
            })
            .pipe(
              Effect.flatMap(environment),
              Effect.catchTag("EnvironmentNotFound", () =>
                notFound("environment", params.environment),
              ),
            )
        }),
      )
      .handle("deleteEnvironment", ({ params }) =>
        Effect.gen(function* () {
          const organizationId = yield* access.project(params.projectId, "admin")

          yield* repository
            .deleteEnvironment({
              ...(yield* audited(organizationId)),
              projectId: params.projectId,
              name: params.environment,
            })
            .pipe(
              Effect.catchTags({
                EnvironmentNotFound: () => notFound("environment", params.environment),
                EnvironmentInUse: () =>
                  Cloud.Conflict.make({ message: "The environment has a current deployment" }),
              }),
            )
        }),
      )
      .handle("getEndpoints", ({ params }) =>
        Effect.gen(function* () {
          yield* access.project(params.projectId)

          return yield* Cloud.NotImplemented.make({ operation: "projects.getEndpoints" })
        }),
      )
  }),
)

export const AccountLive = HttpApiBuilder.group(Cloud.CloudApi, "account", (handlers) =>
  Effect.gen(function* () {
    const { access, auth, refused, repository, services, userRow } = yield* control

    return handlers
      .handle("me", () =>
        Effect.gen(function* () {
          const caller = yield* Cloud.CurrentIdentity
          if (Predicate.isTagged(caller, "api-key"))
            return {
              user: null,
              identityKind: "api-key",
              activeOrganizationId: caller.organizationId,
              organizations: yield* services.memberships,
            }

          return {
            user: yield* userRow(caller.userId),
            identityKind: "session",
            activeOrganizationId: Predicate.isTagged(caller, "session")
              ? caller.activeOrganizationId
              : null,
            organizations: yield* services.memberships,
          }
        }),
      )
      .handle("updateProfile", ({ payload }) =>
        Effect.gen(function* () {
          const userId = yield* access.person
          const h = yield* headers

          yield* refused(() =>
            auth.api.updateUser({ headers: h, body: { name: payload.name, image: payload.image } }),
          )

          return yield* userRow(userId)
        }),
      )
      .handle("setActiveOrganization", ({ payload }) =>
        Effect.gen(function* () {
          yield* access.person
          yield* access.organization(payload.organizationId)
          const h = yield* headers

          yield* Effect.tryPromise({
            try: () =>
              auth.api.setActiveOrganization({
                headers: h,
                body: { organizationId: payload.organizationId },
              }),
            catch: () =>
              Cloud.Conflict.make({ message: "The organization could not be activated" }),
          })

          return yield* services.getOrganization(payload.organizationId)
        }),
      )
      .handle("getPreferences", () =>
        Effect.gen(function* () {
          const userId = yield* access.person

          return yield* repository.getPreferences({ userId })
        }),
      )
      .handle("updatePreferences", ({ payload }) =>
        Effect.gen(function* () {
          const userId = yield* access.person

          return yield* repository.updatePreferences({ userId, changes: payload })
        }),
      )
      .handle("getNotifications", () =>
        Effect.gen(function* () {
          const userId = yield* access.person

          return { preferences: yield* repository.getNotifications({ userId }) }
        }),
      )
      .handle("setNotifications", ({ payload }) =>
        Effect.gen(function* () {
          const userId = yield* access.person

          return {
            preferences: yield* repository.updateNotifications({
              userId,
              changes: payload.preferences,
            }),
          }
        }),
      )
      .handle("listPinnedActors", ({ query }) =>
        Effect.gen(function* () {
          const userId = yield* access.person
          yield* access.project(query.projectId)

          return yield* Effect.forEach(
            yield* repository.listPinnedActors({
              userId,
              projectId: query.projectId,
              environment: query.environment,
            }),
            pinned,
          )
        }),
      )
      .handle("pinActor", ({ payload }) =>
        Effect.gen(function* () {
          const userId = yield* access.person
          const organizationId = yield* access.project(payload.projectId)

          yield* repository
            .pinActor({ organizationId, userId, ...payload })
            .pipe(
              Effect.catchTag("EnvironmentNotFound", () =>
                notFound("environment", payload.environment),
              ),
            )

          return yield* pinned(payload)
        }),
      )
      .handle("unpinActor", ({ query }) =>
        Effect.gen(function* () {
          const userId = yield* access.person
          yield* access.project(query.projectId)

          yield* repository.unpinActor({ userId, ...query })
        }),
      )
  }),
)

export const AuditLive = HttpApiBuilder.group(Cloud.CloudApi, "audit", (handlers) =>
  Effect.gen(function* () {
    const { access, repository } = yield* control

    return handlers.handle("list", ({ params, query }) =>
      Effect.gen(function* () {
        yield* access.organization(params.organizationId, "admin")

        const page = yield* repository
          .listAudit({
            organizationId: params.organizationId,
            action: query.action,
            actorId: query.actorId,
            limit: query.limit,
            cursor: query.cursor,
          })
          .pipe(Effect.catchTag("InvalidCursor", ({ cursor }) => notFound("cursor", cursor)))

        return {
          items: page.items,
          nextCursor: page.nextCursor,
        }
      }),
    )
  }),
)

export const ControlLayers = Layer.mergeAll(ProjectsLive, AccountLive, AuditLive)
