import { CloudApi } from "@akter/cloud-api"
import { Postgres } from "@alchemy.run/better-auth/Postgres"
import { fromNodeProviderChain } from "@distilled.cloud/aws/Credentials"
import { BunHttpServer } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import {
  FetchHttpClient,
  HttpEffect,
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http"
import { Access, AccessLive } from "./access.ts"
import { AccountLayers } from "./accounts.ts"
import { Auth, processRuntimeLayer } from "./auth.ts"
import type { ApiOptions } from "./config.ts"
import { localEmail, sesEmail } from "./email.ts"
import { PendingLayers } from "./pending.ts"
import { Repository, RepositoryLive } from "./repository.ts"
import { ControlLayers } from "./control.ts"
import { SqlClient } from "effect/sql"

export const apiRoutes = HttpApiBuilder.layer(CloudApi, { openapiPath: "/api/openapi.json" }).pipe(
  Layer.provide(Layer.mergeAll(AccountLayers, ControlLayers, PendingLayers)),
  Layer.provide(AccessLive),
  Layer.provide(Access.layer),
)

const authRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* Auth
    const sql = yield* SqlClient.SqlClient
    const repository = yield* Repository
    const teamRoutes = [
      "create-team",
      "remove-team",
      "update-team",
      "list-teams",
      "set-active-team",
      "list-user-teams",
      "list-team-members",
      "add-team-member",
      "remove-team-member",
    ].map((name) => `/auth/organization/${name}`)
    yield* router.add(
      "*",
      "/auth/*",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const path = request.url.split("?")[0] ?? ""
        if (
          (path.startsWith("/auth/organization/") && !teamRoutes.includes(path)) ||
          path.startsWith("/auth/api-key/")
        )
          return HttpServerResponse.empty({ status: 404 })
        if (teamRoutes.includes(path)) {
          const session = yield* Effect.tryPromise(() =>
            auth.api.getSession({ headers: new Headers(request.headers) }),
          ).pipe(Effect.orDie)
          if (session === null || !session.user.emailVerified)
            return HttpServerResponse.empty({ status: 401 })
          const mutation = [
            "create-team",
            "remove-team",
            "update-team",
            "add-team-member",
            "remove-team-member",
          ].some((name) => path.endsWith(`/${name}`))
          if (mutation) {
            const web = yield* HttpServerRequest.toWeb(request)
            const body = yield* Effect.tryPromise(() => web.clone().json()).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Struct({
                    organizationId: Schema.optional(Schema.String),
                    teamId: Schema.optional(Schema.String),
                  }),
                ),
              ),
              Effect.orDie,
            )
            const rows =
              body.teamId === undefined
                ? []
                : yield* sql<{
                    organizationId: string
                  }>`SELECT "organizationId" FROM team WHERE id = ${body.teamId}`.pipe(Effect.orDie)
            const organizationId =
              rows[0]?.organizationId ?? body.organizationId ?? session.session.activeOrganizationId
            if (organizationId === undefined || organizationId === null)
              return HttpServerResponse.empty({ status: 403 })
            const [member] = yield* sql<{
              role: string
            }>`SELECT role FROM member WHERE "organizationId" = ${organizationId} AND "userId" = ${session.user.id}`.pipe(
              Effect.orDie,
            )
            if (member === undefined || (member.role !== "owner" && member.role !== "admin"))
              return HttpServerResponse.empty({ status: 403 })
            const action = `team.${path.slice(path.lastIndexOf("/") + 1)}`
            const input = {
              organizationId,
              actor: { kind: "user", id: session.user.id, name: session.user.name },
              target: { type: "team", id: body.teamId ?? null },
            } satisfies Omit<Parameters<Repository["Service"]["recordAudit"]>[0], "action">
            yield* repository.recordAudit({ ...input, action: `${action}.requested` })
            const response = yield* HttpEffect.fromWebHandler(auth.handler)
            if (response.status >= 200 && response.status < 300)
              yield* repository.recordAudit({ ...input, action })
            return response
          }
        }
        if (
          [
            "/auth/sso/register",
            "/auth/sso/update-provider",
            "/auth/sso/delete-provider",
            "/auth/sso/request-domain-verification",
            "/auth/sso/verify-domain",
          ].includes(path)
        ) {
          const web = yield* HttpServerRequest.toWeb(request)
          const body = yield* Effect.tryPromise(() => web.clone().json()).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  organizationId: Schema.optional(Schema.String),
                  providerId: Schema.optional(Schema.String),
                }),
              ),
            ),
            Effect.orDie,
          )
          const session = yield* Effect.tryPromise(() =>
            auth.api.getSession({ headers: new Headers(request.headers) }),
          ).pipe(Effect.orDie)
          if (session === null || !session.user.emailVerified)
            return HttpServerResponse.empty({ status: 401 })
          const rows =
            path === "/auth/sso/register"
              ? yield* sql<{
                  organizationId: string
                }>`SELECT id AS "organizationId" FROM organization WHERE id = ${body.organizationId ?? ""}`.pipe(
                  Effect.orDie,
                )
              : yield* sql<{
                  organizationId: string
                }>`SELECT "organizationId" FROM "ssoProvider" WHERE "providerId" = ${body.providerId ?? ""}`.pipe(
                  Effect.orDie,
                )
          const organizationId = rows[0]?.organizationId
          if (
            organizationId === undefined ||
            !auth.enterpriseOrganizations.includes(organizationId)
          )
            return HttpServerResponse.empty({ status: 403 })
          const [member] = yield* sql<{
            role: string
          }>`SELECT role FROM member WHERE "organizationId" = ${organizationId} AND "userId" = ${session.user.id}`.pipe(
            Effect.orDie,
          )
          if (member === undefined || (member.role !== "owner" && member.role !== "admin"))
            return HttpServerResponse.empty({ status: 403 })
          const action = `sso.${path.slice(path.lastIndexOf("/") + 1)}`
          const input = {
            organizationId,
            actor: { kind: "user", id: session.user.id, name: session.user.name },
            target: { type: "sso-provider", id: body.providerId ?? null },
            ip: Option.getOrUndefined(request.remoteAddress),
          } satisfies Omit<Parameters<Repository["Service"]["recordAudit"]>[0], "action">
          yield* repository.recordAudit({ ...input, action: `${action}.requested` })
          const response = yield* HttpEffect.fromWebHandler(auth.handler)
          if (response.status >= 200 && response.status < 300)
            yield* repository.recordAudit({ ...input, action })
          return response
        }
        return yield* HttpEffect.fromWebHandler(auth.handler)
      }),
    )
    yield* router.add("GET", "/ready", Effect.succeed(HttpServerResponse.text("ready")))
  }),
)

export const infrastructure = (options: ApiOptions) => {
  const sql = PgClient.layer({ url: options.databaseUrl, maxConnections: 10 })
  const email =
    options.emailMode === "local"
      ? localEmail
      : sesEmail(options.emailFrom).pipe(
          Layer.provide(Layer.mergeAll(fromNodeProviderChain(), FetchHttpClient.layer)),
        )
  const auth = Auth.layer(options).pipe(
    Layer.provide(email),
    Layer.provide(Postgres(Redacted.value(options.databaseUrl), { pool: { max: 5 } })),
    Layer.provide(processRuntimeLayer),
  )
  return Layer.mergeAll(auth, RepositoryLive).pipe(Layer.provideMerge(sql))
}

export const routes = Layer.mergeAll(
  apiRoutes,
  authRoutes,
  HttpRouter.middleware(
    Effect.map(Auth, (auth) =>
      HttpMiddleware.cors({ allowedOrigins: auth.allowedBrowserOrigins, credentials: true }),
    ),
    { global: true },
  ),
)

export const ApiLive = (options: ApiOptions) =>
  HttpRouter.serve(routes, { disableLogger: true }).pipe(
    Layer.provide(infrastructure(options)),
    Layer.provide(
      BunHttpServer.layer({
        port: options.port,
        hostname: options.hostname ?? (options.production ? "0.0.0.0" : "127.0.0.1"),
      }),
    ),
  )
