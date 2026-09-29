import { Context, Effect, Layer, Schema } from "effect"
import { BetterAuth } from "@alchemy.run/better-auth"
import { Drizzle } from "@alchemy.run/better-auth/Drizzle"
import { RuntimeContext, unpackEnvValue } from "alchemy/RuntimeContext"
import { organization } from "better-auth/plugins"
import { AuthDatabase } from "@durable-actors/postgres"
import * as schema from "@durable-actors/postgres/schema"
import { Email } from "@durable-actors/email"

/**
 * Settings for the auth service: signing `secret`, public `origin` (also the
 * only trusted origin) and whether cookies are secure-only.
 */
export interface AuthConfig {
  readonly secret: string
  readonly origin: string
  readonly production: boolean
}

/**
 * Builds the better-auth instance over the Drizzle database. The database is
 * checked, not decoded: the adapter must receive the raw instance with
 * Drizzle's prototype, not a copy or an Effect proxy.
 */
const makeAuth = Effect.fn("Auth.make")(function* (config: AuthConfig) {
  const effectContext = yield* Effect.context<never>()

  const db = yield* AuthDatabase
  const email = yield* Email

  if (!Schema.is(Schema.Record(Schema.String, Schema.Unknown))(db)) {
    return yield* Effect.die(new Error("Drizzle database must be an object"))
  }

  const send = (to: string, subject: string, text: string) =>
    Effect.runPromiseWith(effectContext)(email.send({ to, subject, text }))

  return yield* BetterAuth({
    secret: config.secret,
    baseURL: config.origin,
    basePath: "/auth",
    trustedOrigins: [config.origin],
    migrate: false,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }) =>
        send(user.email, "Reset your password", `Reset your password: ${url}`),
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: ({ user, url }) =>
        send(user.email, "Verify your email", `Verify your email: ${url}`),
    },
    plugins: [
      organization({
        requireEmailVerificationOnInvitation: true,
        sendInvitationEmail: ({ email, id, organization }) =>
          send(
            email,
            `Join ${organization.name}`,
            `Accept your invitation: ${config.origin}/accept-invitation?invitationId=${encodeURIComponent(id)}`,
          ),
      }),
    ],
    advanced: { useSecureCookies: config.production },
  })
})

/** @effect-expect-leaking RuntimeContext */
export class Auth extends Context.Service<Auth, Effect.Success<ReturnType<typeof makeAuth>>>()(
  "@durable-actors/accounts/Auth",
) {
  static layer = (config: AuthConfig) =>
    Layer.unwrap(
      Effect.map(AuthDatabase, (db) => {
        if (!Schema.is(Schema.Record(Schema.String, Schema.Unknown))(db)) {
          return Layer.effect(Auth, Effect.die(new Error("Drizzle database must be an object")))
        }

        return Layer.effect(Auth, makeAuth(config)).pipe(
          Layer.provide(Drizzle(db, { provider: "pg", schema })),
        )
      }),
    )
}

const runtimeEnvironment = process.env

/**
 * Runtime context for a long-lived Bun process. Bindings come from the process
 * environment and are read-only: setting one dies, since resources must be
 * provisioned before the API starts. Each request has its own scope, which is
 * the wrapper's execution memo key.
 */
export const processRuntimeLayer = Layer.succeed(RuntimeContext, {
  Type: "BunProcess",
  id: "project-api",
  env: runtimeEnvironment,
  get: <T>(key: string) => Effect.sync(() => unpackEnvValue<T>(runtimeEnvironment[key])),
  set: () =>
    Effect.die(new Error("Runtime resource bindings must be provisioned before starting the API")),
})
