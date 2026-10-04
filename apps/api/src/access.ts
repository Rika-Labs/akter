import {
  ApiKeyId,
  ApiKeyPermission,
  OrganizationId,
  UserId,
  ApiKeyIdentity,
  Authentication,
  CurrentIdentity,
  Forbidden,
  SessionIdentity,
  Unauthorized,
} from "@akter/cloud-api"
import { Context, Effect, Layer, Predicate, Redacted, Schema } from "effect"
import { HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { Actor, System } from "@rikalabs/akter"
import { Auth } from "./auth.ts"

export const AccessLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const auth = yield* Auth
    const sql = yield* SqlClient.SqlClient
    const checkOrigin = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const origin = request.headers.origin
      if (
        request.headers["x-api-key"] === undefined &&
        request.method !== "GET" &&
        request.method !== "HEAD" &&
        origin !== undefined &&
        !auth.allowedBrowserOrigins.includes(origin)
      )
        return yield* Forbidden.make({ message: "Untrusted browser origin" })
    })
    /**
     * Resolves the Better Auth session that `headers` carry: the request's
     * cookies, or, for a bearer token, only that token, so a cookie sent
     * beside it can never stand in for it.
     */
    const resolveSession = (headers: (request: HttpServerRequest.HttpServerRequest) => Headers) =>
      Effect.gen(function* () {
        yield* checkOrigin
        const request = yield* HttpServerRequest.HttpServerRequest
        if (request.headers["x-api-key"] !== undefined)
          return yield* Unauthorized.make({
            code: "invalid_credentials",
            message: "An explicit API key takes precedence over a session",
          })
        const found = yield* Effect.tryPromise({
          try: () => auth.api.getSession({ headers: headers(request) }),
          catch: () =>
            Unauthorized.make({
              code: "invalid_credentials",
              message: "Session could not be verified",
            }),
        })
        if (found === null || !found.user.emailVerified)
          return yield* Unauthorized.make({
            code: "missing_credentials",
            message: "A verified session is required",
          })
        return SessionIdentity.make({
          userId: UserId.make(found.user.id),
          sessionId: found.session.id,
          activeOrganizationId:
            found.session.activeOrganizationId == null
              ? null
              : OrganizationId.make(found.session.activeOrganizationId),
        })
      })
    const asPerson = <A, E, R>(
      resolved: Effect.Effect<
        typeof SessionIdentity.Type,
        Unauthorized | Forbidden,
        HttpServerRequest.HttpServerRequest
      >,
      effect: Effect.Effect<A, E, R>,
    ) =>
      Effect.flatMap(resolved, (identity) =>
        Effect.provideService(
          effect.pipe(
            Actor.as(System.make({ source: "process", onBehalfOf: { subject: identity.userId } })),
          ),
          CurrentIdentity,
          identity,
        ),
      )
    /**
     * Refuses a scheme when the request also carries `Authorization`. Every
     * scheme runs on every request, and Better Auth would otherwise read a
     * valid bearer token, or fall back to the cookie beside an invalid one,
     * inside the cookie schemes, so only the bearer scheme may answer a
     * request that sends one.
     */
    const withoutBearer = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.headers.authorization !== undefined)
        return yield* Unauthorized.make({
          code: "invalid_credentials",
          message: "A bearer token is the request's only credential",
        })
    })
    const cookieSession = withoutBearer.pipe(
      Effect.andThen(resolveSession((request) => new Headers(request.headers))),
    )
    return Authentication.of({
      session: (effect) => asPerson(cookieSession, effect),
      secureSession: (effect) => asPerson(cookieSession, effect),
      bearer: (effect, { credential }) =>
        Redacted.value(credential) === ""
          ? Effect.fail(
              Unauthorized.make({
                code: "missing_credentials",
                message: "A verified session is required",
              }),
            )
          : asPerson(
              resolveSession(
                () => new Headers({ authorization: `Bearer ${Redacted.value(credential)}` }),
              ),
              effect,
            ),
      apiKey: (effect, { credential }) =>
        Effect.gen(function* () {
          yield* withoutBearer
          yield* checkOrigin
          const result = yield* Effect.tryPromise({
            try: () => auth.api.verifyApiKey({ body: { key: Redacted.value(credential) } }),
            catch: () =>
              Unauthorized.make({
                code: "invalid_credentials",
                message: "API key could not be verified",
              }),
          })
          if (!result.valid || result.key === null)
            return yield* Unauthorized.make({
              code: "invalid_credentials",
              message: "API key is invalid",
            })
          const [binding] = yield* sql<{
            organization_id: string
            permission: string
          }>`SELECT k.organization_id, k.permission FROM cloud_api_key k JOIN organization o ON o.id = k.organization_id WHERE k.id = ${result.key.id} AND k.revoked_at IS NULL`.pipe(
            Effect.orDie,
          )
          if (binding === undefined || binding.organization_id !== result.key.referenceId)
            return yield* Unauthorized.make({
              code: "invalid_credentials",
              message: "API key has no active grant",
            })
          const identity = ApiKeyIdentity.make({
            keyId: ApiKeyId.make(result.key.id),
            organizationId: OrganizationId.make(binding.organization_id),
            permission: yield* Schema.decodeUnknownEffect(ApiKeyPermission)(
              binding.permission,
            ).pipe(Effect.orDie),
          })
          return yield* Effect.provideService(
            effect.pipe(
              Actor.as(System.make({ source: "process", onBehalfOf: { subject: identity.keyId } })),
            ),
            CurrentIdentity,
            identity,
          )
        }),
    })
  }),
)

/**
 * The control plane's name for a verified caller, `user:<id>` or
 * `api-key:<id>`: what deployment audit entries name as the initiator and what
 * a runner sees as the caller of a command sent through the console.
 */
export const attributedSubject = (identity: CurrentIdentity["Service"]) =>
  Predicate.isTagged(identity, "session") ? `user:${identity.userId}` : `api-key:${identity.keyId}`

/** @effect-expect-leaking CurrentIdentity */
export class Access extends Context.Service<
  Access,
  {
    readonly organization: (
      organizationId: string,
      permission?: "read" | "write" | "admin",
    ) => Effect.Effect<{ role: string }, Forbidden, CurrentIdentity>
    readonly project: (
      projectId: string,
      permission?: "read" | "write" | "admin",
    ) => Effect.Effect<string, Forbidden, CurrentIdentity>
    readonly person: Effect.Effect<string, Forbidden, CurrentIdentity>
  }
>()("@akter/api/access") {
  static layer = Layer.effect(
    Access,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const organization = Effect.fn("Access.organization")(function* (
        organizationId: string,
        permission: "read" | "write" | "admin" = "read",
      ) {
        const caller = yield* CurrentIdentity
        if (Predicate.isTagged(caller, "api-key")) {
          if (caller.organizationId !== organizationId)
            return yield* Forbidden.make({ message: "Organization access refused" })
          const [grant] = yield* sql<{
            permission: string
            project_id: string | null
          }>`SELECT permission, project_id FROM cloud_api_key WHERE id = ${caller.keyId} AND revoked_at IS NULL`.pipe(
            Effect.orDie,
          )
          if (
            grant === undefined ||
            grant.project_id !== null ||
            (permission === "admin" && grant.permission !== "admin") ||
            (permission === "write" && grant.permission === "read")
          )
            return yield* Forbidden.make({ message: "Key scope does not allow this operation" })
          return { role: grant.permission }
        }
        const [member] = yield* sql<{
          role: string
        }>`SELECT role FROM member WHERE "organizationId" = ${organizationId} AND "userId" = ${caller.userId}`.pipe(
          Effect.orDie,
        )
        if (
          member === undefined ||
          (permission === "admin" && member.role !== "owner" && member.role !== "admin") ||
          (permission === "write" && member.role === "viewer")
        )
          return yield* Forbidden.make({ message: "Organization access refused" })
        return member
      })
      return Access.of({
        organization,
        project: Effect.fn("Access.project")(function* (
          projectId: string,
          permission: "read" | "write" | "admin" = "read",
        ) {
          const [project] = yield* sql<{
            organization_id: string
          }>`SELECT organization_id FROM cloud_project WHERE id = ${projectId}`.pipe(Effect.orDie)
          if (project === undefined)
            return yield* Forbidden.make({ message: "Project access refused" })
          const caller = yield* CurrentIdentity
          if (Predicate.isTagged(caller, "api-key")) {
            const [grant] = yield* sql<{
              permission: string
              project_id: string | null
            }>`SELECT permission, project_id FROM cloud_api_key WHERE id = ${caller.keyId} AND organization_id = ${project.organization_id} AND revoked_at IS NULL`.pipe(
              Effect.orDie,
            )
            if (
              grant === undefined ||
              (grant.project_id !== null && grant.project_id !== projectId) ||
              (permission === "admin" && grant.permission !== "admin") ||
              (permission === "write" && grant.permission === "read")
            )
              return yield* Forbidden.make({ message: "Project access refused" })
          } else yield* organization(project.organization_id, permission)
          return project.organization_id
        }),
        person: Effect.flatMap(CurrentIdentity, (caller) =>
          Predicate.isTagged(caller, "session")
            ? Effect.succeed(caller.userId)
            : Effect.fail(Forbidden.make({ message: "This operation requires a person" })),
        ),
      })
    }),
  )
}
