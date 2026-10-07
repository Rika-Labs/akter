import { Effect, Layer, Predicate, Redacted } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { afterAll, describe, expect, it } from "vitest"

import {
  ApiKeyIdentity,
  Authentication,
  CurrentIdentity,
  SessionIdentity,
  apiKeyHeaderName,
  secureSessionCookieName,
  sessionCookieName,
} from "./auth.ts"
import { NotImplemented, Unauthorized } from "./errors.ts"
import { AccountGroup } from "./groups/account.ts"
import { DeploymentsGroup } from "./groups/deployments.ts"
import { ApiKeyId, Email, OrganizationId, UserId } from "./primitives.ts"

const Api = HttpApi.make("auth-test")
  .add(AccountGroup, DeploymentsGroup)
  .middleware(Authentication)
  .prefix("/api")

const reject = (code: "invalid_credentials" | "missing_credentials") =>
  Effect.fail(Unauthorized.make({ code, message: code }))

const AuthenticationLive = Layer.succeed(
  Authentication,
  Authentication.of({
    session: (httpEffect, { credential }) =>
      Redacted.value(credential) === "session-token"
        ? Effect.provideService(
            httpEffect,
            CurrentIdentity,
            SessionIdentity.make({
              userId: UserId.make("usr_1"),
              sessionId: "ses_1",
              activeOrganizationId: null,
            }),
          )
        : reject("invalid_credentials"),
    secureSession: (httpEffect, { credential }) =>
      Redacted.value(credential) === "secure-token"
        ? Effect.provideService(
            httpEffect,
            CurrentIdentity,
            SessionIdentity.make({
              userId: UserId.make("usr_2"),
              sessionId: "ses_2",
              activeOrganizationId: null,
            }),
          )
        : reject("invalid_credentials"),
    apiKey: (httpEffect, { credential }) =>
      Redacted.value(credential) === "key-secret"
        ? Effect.provideService(
            httpEffect,
            CurrentIdentity,
            ApiKeyIdentity.make({
              keyId: ApiKeyId.make("key_1"),
              organizationId: OrganizationId.make("org_1"),
              permission: "read",
            }),
          )
        : reject("missing_credentials"),
    bearer: (httpEffect, { credential }) =>
      Redacted.value(credential) === "device-token"
        ? Effect.provideService(
            httpEffect,
            CurrentIdentity,
            SessionIdentity.make({
              userId: UserId.make("usr_3"),
              sessionId: "ses_3",
              activeOrganizationId: null,
            }),
          )
        : reject("invalid_credentials"),
  }),
)

const AccountHandlers = HttpApiBuilder.group(Api, "account", (handlers) =>
  Effect.succeed(
    handlers
      .handle("me", () =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity
          return {
            user: Predicate.isTagged(identity, "session")
              ? {
                  id: identity.userId,
                  name: "Ada",
                  email: Email.make("ada@acme.dev"),
                  emailVerified: true,
                  image: null,
                }
              : null,
            identityKind: identity._tag,
            activeOrganizationId: null,
            organizations: [],
          }
        }),
      )
      .handle("updateProfile", () => Effect.fail(NotImplemented.make({ operation: "x" })))
      .handle("deleteAccount", () => Effect.fail(NotImplemented.make({ operation: "x" })))
      .handle("exportData", () => Effect.fail(NotImplemented.make({ operation: "x" })))
      .handle("setActiveOrganization", () => Effect.fail(NotImplemented.make({ operation: "x" })))
      .handle("getPreferences", () => Effect.fail(NotImplemented.make({ operation: "x" })))
      .handle("updatePreferences", () => Effect.fail(NotImplemented.make({ operation: "x" })))
      .handle("getNotifications", () => Effect.fail(NotImplemented.make({ operation: "x" })))
      .handle("setNotifications", () => Effect.fail(NotImplemented.make({ operation: "x" })))
      .handle("listPinnedActors", () => Effect.fail(NotImplemented.make({ operation: "x" })))
      .handle("pinActor", () => Effect.fail(NotImplemented.make({ operation: "x" })))
      .handle("unpinActor", () => Effect.fail(NotImplemented.make({ operation: "x" }))),
  ),
)

const DeploymentsHandlers = HttpApiBuilder.group(Api, "deployments", (handlers) =>
  Effect.succeed(
    handlers
      .handle("list", () => Effect.fail(NotImplemented.make({ operation: "deployments.list" })))
      .handle("create", () => Effect.fail(NotImplemented.make({ operation: "x" })))
      .handle("uploadSource", () => Effect.fail(NotImplemented.make({ operation: "x" })))
      .handle("get", () => Effect.fail(NotImplemented.make({ operation: "x" })))
      .handle("getBuildLog", () => Effect.fail(NotImplemented.make({ operation: "x" })))
      .handle("getEnvironmentLogs", () => Effect.fail(NotImplemented.make({ operation: "logs" })))
      .handle("getLogs", () => Effect.fail(NotImplemented.make({ operation: "logs" })))
      .handle("recordBuild", () => Effect.fail(NotImplemented.make({ operation: "x" })))
      .handle("failBuild", () => Effect.fail(NotImplemented.make({ operation: "x" })))
      .handle("rollback", () => Effect.fail(NotImplemented.make({ operation: "x" })))
      .handle("redeploy", () => Effect.fail(NotImplemented.make({ operation: "x" }))),
  ),
)

const { handler, dispose } = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide([AccountHandlers, DeploymentsHandlers]),
    Layer.provideMerge(AuthenticationLive),
    Layer.provide(HttpServer.layerServices),
  ),
  { disableLogger: true },
)

afterAll(() => dispose())

const send = (path: string, headers: Record<string, string> = {}) =>
  Effect.promise(() => handler(new Request(`http://cloud.test${path}`, { headers }))).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise(() => response.json()).pipe(
        Effect.orElseSucceed(() => null),
        Effect.map((body) => ({ status: response.status, body })),
      ),
    ),
  )

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

const key = { [apiKeyHeaderName]: "key-secret" }

describe("Authentication over HTTP", () => {
  it("answers 401 with a typed Unauthorized when no credential is sent", () =>
    run(
      Effect.gen(function* () {
        const response = yield* send("/api/me")
        expect(response.status).toBe(401)
        expect(response.body).toHaveProperty("_tag", "Unauthorized")
      }),
    ))

  it("resolves a person from the session cookie", () =>
    run(
      Effect.gen(function* () {
        const response = yield* send("/api/me", { cookie: `${sessionCookieName}=session-token` })
        expect(response.status).toBe(200)
        expect(response.body).toMatchObject({
          identityKind: "session",
          user: { id: "usr_1", email: "ada@acme.dev" },
        })
      }),
    ))

  it("resolves a person from the __Secure- cookie Better Auth sets over HTTPS", () =>
    run(
      Effect.gen(function* () {
        const response = yield* send("/api/me", {
          cookie: `${secureSessionCookieName}=secure-token`,
        })
        expect(response.status).toBe(200)
        expect(response.body).toMatchObject({ user: { id: "usr_2" } })
      }),
    ))

  it("resolves an API key to an organization actor with no user", () =>
    run(
      Effect.gen(function* () {
        const response = yield* send("/api/me", key)
        expect(response.status).toBe(200)
        expect(response.body).toMatchObject({ identityKind: "api-key", user: null })
      }),
    ))

  it("resolves a person from a CLI's bearer session token", () =>
    run(
      Effect.gen(function* () {
        const response = yield* send("/api/me", { authorization: "Bearer device-token" })
        expect(response.status).toBe(200)
        expect(response.body).toMatchObject({ identityKind: "session", user: { id: "usr_3" } })
      }),
    ))

  it("refuses a wrong cookie, a wrong key and a wrong bearer token instead of falling back to anonymous", () =>
    run(
      Effect.gen(function* () {
        const wrongCookie = yield* send("/api/me", { cookie: `${sessionCookieName}=forged` })
        const wrongKey = yield* send("/api/me", { [apiKeyHeaderName]: "guess" })
        const wrongBearer = yield* send("/api/me", { authorization: "Bearer guess" })
        expect([wrongCookie.status, wrongKey.status, wrongBearer.status]).toEqual([401, 401, 401])
      }),
    ))

  it("refuses a credential carried in the URL", () =>
    run(
      Effect.gen(function* () {
        const response = yield* send("/api/me?x-api-key=key-secret")
        expect(response.status).toBe(401)
      }),
    ))

  it("serves nothing outside /api", () =>
    run(
      Effect.gen(function* () {
        const response = yield* send("/me", key)
        expect(response.status).toBe(404)
      }),
    ))

  it("validates paging query before the handler runs, so a bad limit is 400 and a good one reaches 501", () =>
    run(
      Effect.gen(function* () {
        const path = "/api/projects/prj_1/deployments"
        const statuses = yield* Effect.forEach(
          [`${path}?limit=0`, `${path}?limit=101`, `${path}?limit=abc`, `${path}?limit=100`, path],
          (url) => send(url, key).pipe(Effect.map((response) => response.status)),
        )
        expect(statuses).toEqual([400, 400, 400, 501, 501])
      }),
    ))

  it("encodes the declared NotImplemented error as 501 with its operation", () =>
    run(
      Effect.gen(function* () {
        const response = yield* send("/api/projects/prj_1/deployments", key)
        expect(response.status).toBe(501)
        expect(response.body).toHaveProperty("_tag", "NotImplemented")
        expect(response.body).toHaveProperty("operation", "deployments.list")
      }),
    ))
})
