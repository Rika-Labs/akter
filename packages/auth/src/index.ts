import { Context, Effect, Layer, Schema } from "effect"
import { BetterAuth } from "@alchemy.run/better-auth"
import { Drizzle } from "@alchemy.run/better-auth/Drizzle"
import { RuntimeContext, unpackEnvValue } from "alchemy/RuntimeContext"
import { organization } from "better-auth/plugins"
import { AuthDatabase } from "@project/database"
import * as schema from "@project/database/schema"
import { Email } from "@project/email"

export interface AuthConfig {
  readonly secret: string
  readonly origin: string
  readonly production: boolean
}

const makeAuth = Effect.fn("Auth.make")(function* (config: AuthConfig) {
  const effectContext = yield* Effect.context<never>()

  const db = yield* AuthDatabase
  const email = yield* Email

  // Validate the wrapper's broad object input while retaining Drizzle's prototype.
  // The adapter must receive the raw instance, not a decoded copy or Effect proxy.
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
  "@project/auth/Auth",
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

// A long-lived Bun process is the host. Raw Drizzle owns no Alchemy Outputs.
// Every request has its own Scope, which is the wrapper's execution memo key.
// No global __ALCHEMY_RUNTIME__ spoofing, stack, or deployment action is needed.
const runtimeEnvironment = process.env

export const processRuntimeLayer = Layer.succeed(RuntimeContext, {
  Type: "BunProcess",
  id: "project-api",
  env: runtimeEnvironment,
  get: <T>(key: string) => Effect.sync(() => unpackEnvValue<T>(runtimeEnvironment[key])),
  set: () =>
    Effect.die(new Error("Runtime resource bindings must be provisioned before starting the API")),
})
