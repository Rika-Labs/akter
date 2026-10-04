import { BetterAuth, Database } from "@alchemy.run/better-auth"
import { applyMigrations } from "@alchemy.run/better-auth/Migrate"
import { RuntimeContext, unpackEnvValue } from "alchemy/RuntimeContext"
import { getCurrentDBAdapterAsyncLocalStorage } from "@better-auth/core/context"
import { apiKey } from "@better-auth/api-key"
import { sso } from "@better-auth/sso"
import { bearer, deviceAuthorization, organization } from "better-auth/plugins"
import { createAccessControl } from "better-auth/plugins/access"
import {
  defaultStatements,
  ownerAc,
  adminAc,
  memberAc,
} from "better-auth/plugins/organization/access"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { Email } from "./email.ts"
import type { ApiOptions } from "./config.ts"
import { CLI_CLIENT_ID, devicePolicy } from "./device.ts"

/**
 * Better Auth sends mail from inside its open database transaction, and Bun
 * keeps that transaction's async-local store attached to every task the Effect
 * runtime schedules from there. Once the transaction commits, later sessions
 * read the committed transaction and fail, so each send runs outside the store.
 *
 * The bearer plugin keeps only its request hook, so the session token a CLI
 * receives from the device authorization grant authenticates as
 * `Authorization: Bearer`. Its response hook would copy every new session
 * token, browser sign-ins included, into a script-readable `set-auth-token`
 * header, so it is left out and browser sessions stay in their HTTP-only
 * cookie.
 */
const makeAuth = Effect.fn("Auth.make")(function* (options: ApiOptions) {
  const email = yield* Email
  const context = yield* Effect.context<never>()
  const pending = new Set<Promise<unknown>>()
  yield* Effect.addFinalizer(() => Effect.promise(() => Promise.allSettled(pending)))
  const linkBase = options.consoleOrigin ?? options.origin
  const withCallback = (url: string, path: string) => {
    const link = new URL(url)
    const target = link.searchParams.get("callbackURL")
    if (target === null || ["", "/", "undefined"].includes(target))
      link.searchParams.set("callbackURL", `${linkBase}${path}`)
    return link.href
  }
  const send = (to: string, subject: string, text: string) =>
    getCurrentDBAdapterAsyncLocalStorage().then((store) =>
      store.exit(() => Effect.runPromiseWith(context)(email.send({ to, subject, text }))),
    )
  const ac = createAccessControl({
    ...defaultStatements,
    apiKey: ["create", "read", "update", "delete"],
  })
  const organizationPlugin = organization({
    ac,
    roles: {
      owner: ac.newRole({ ...ownerAc.statements, apiKey: ["create", "read", "update", "delete"] }),
      admin: ac.newRole({ ...adminAc.statements, apiKey: ["create", "read", "update", "delete"] }),
      member: ac.newRole({ ...memberAc.statements, apiKey: ["read"] }),
      viewer: ac.newRole({}),
    },
    teams: { enabled: true },
    requireEmailVerificationOnInvitation: true,
    sendInvitationEmail: ({ email, id, organization }) =>
      send(email, `Join ${organization.name}`, `${linkBase}/invitations/${encodeURIComponent(id)}`),
  })
  const keyPlugin = apiKey({
    references: "organization",
    defaultPrefix: "akter_",
    enableMetadata: true,
    rateLimit: { enabled: false },
  })
  const devicePlugin = deviceAuthorization({
    expiresIn: "10m",
    interval: "5s",
    verificationUri: `${linkBase}/device`,
    validateClient: (clientId) => clientId === CLI_CLIENT_ID,
  })
  const bearerPlugin = { ...bearer(), hooks: { before: bearer().hooks.before } }
  const enterpriseOrganizations = options.enterpriseOrganizations ?? []
  const ssoPlugin = sso({
    domainVerification: { enabled: true },
    trustEmailVerified: true,
    resolveUser: (input, context) =>
      context.database
        .findOne<{ organizationId: string | null; domain: string; domainVerified: boolean }>({
          model: "ssoProvider",
          where: [{ field: "providerId", value: input.providerId }],
        })
        .then((provider) => {
          if (
            provider === null ||
            provider.organizationId === null ||
            !enterpriseOrganizations.includes(provider.organizationId)
          )
            return { action: "reject", code: "SSO_ENTERPRISE_REQUIRED" }
          const domain = input.providerUser.email
            .slice(input.providerUser.email.lastIndexOf("@") + 1)
            .toLowerCase()
          if (!provider.domainVerified || domain !== provider.domain.toLowerCase())
            return { action: "reject", code: "SSO_DOMAIN_MISMATCH" }
          return { action: "continue" }
        }),
  })
  const settings = {
    secret: options.secret,
    baseURL: options.origin,
    basePath: "/auth",
    trustedOrigins: [
      options.origin,
      ...(options.consoleOrigin === undefined ? [] : [options.consoleOrigin]),
      ...(options.trustedIdpOrigins ?? []),
    ],
    migrate: false,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }: { user: { email: string }; url: string }) =>
        send(user.email, "Reset your password", withCallback(url, "/reset-password")),
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: ({ user, url }: { user: { email: string }; url: string }) =>
        send(user.email, "Verify your email", withCallback(url, "/")),
    },
    socialProviders: { github: options.github, google: options.google },
    account: { accountLinking: { enabled: false } },
    rateLimit: {
      enabled: options.production,
      customRules: { "/device": { window: 600, max: 20 } },
    },
    plugins: [
      organizationPlugin,
      keyPlugin,
      ssoPlugin,
      devicePlugin,
      devicePolicy,
      bearerPlugin,
    ] satisfies [
      typeof organizationPlugin,
      typeof keyPlugin,
      typeof ssoPlugin,
      typeof devicePlugin,
      typeof devicePolicy,
      typeof bearerPlugin,
    ],
    advanced: {
      useSecureCookies: options.production,
      disableCSRFCheck: false,
      disableOriginCheck: false,
      backgroundTasks: {
        handler: (promise: Promise<unknown>) => {
          pending.add(promise)
          void promise.then(
            () => pending.delete(promise),
            () => pending.delete(promise),
          )
        },
      },
    },
    logger: { disabled: true },
    telemetry: { enabled: false },
  }
  const database = yield* Database
  const sql = yield* SqlClient.SqlClient
  if (database.migrate === undefined)
    return yield* Effect.die(new Error("Auth database must support migrations"))
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(499500501)`
      yield* applyMigrations(database.migrate!, { ...settings, secret: "migration-only" })
    }),
  )
  const wrapped = yield* BetterAuth(settings)
  const auth = yield* wrapped.auth
  return {
    ...auth,
    enterpriseOrganizations,
    allowedBrowserOrigins: [
      options.origin,
      ...(options.consoleOrigin === undefined ? [] : [options.consoleOrigin]),
    ],
  }
})

export class Auth extends Context.Service<Auth, Effect.Success<ReturnType<typeof makeAuth>>>()(
  "@akter/api/auth",
) {
  static layer = (options: ApiOptions) => Layer.effect(Auth, makeAuth(options))
}

/** Long-lived Bun processes own their resource scope and read provisioned bindings without mutating them. */
const runtimeEnvironment = process.env

export const processRuntimeLayer = Layer.succeed(RuntimeContext, {
  Type: "BunProcess",
  id: "akter-api",
  env: runtimeEnvironment,
  get: <T>(key: string) => Effect.sync(() => unpackEnvValue<T>(runtimeEnvironment[key])),
  set: () => Effect.die(new Error("Runtime bindings are read-only")),
})
