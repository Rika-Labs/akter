import { Cause, ConfigProvider, Effect, Exit, Redacted } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { loadOptions } from "./config.ts"

describe("API configuration", () => {
  it.effect("requires a durable database and signing secret", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        loadOptions.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
        ),
      )
      expect(result._tag).toBe("Failure")
    }),
  )
  it.effect("loads local settings without requiring OAuth, Resend or Fly credentials", () =>
    Effect.gen(function* () {
      const options = yield* loadOptions.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            CONTROL_PLANE_DATABASE_URL: "postgres://project:project@localhost/postgres",
            AUTH_SECRET: "a-local-test-signing-secret-long-enough",
          }),
        ),
      )
      expect(options.port).toBe(3001)
      expect(options.emailMode).toBe("local")
      expect(options.billingMode).toBe("local")
      expect(options.stripeApiKey).toBeUndefined()
      expect(options.github).toBeUndefined()
      expect(Redacted.value(options.databaseUrl)).toBe(
        "postgres://project:project@localhost/postgres",
      )
    }),
  )
  it.effect(
    "requires Stripe credentials and a nondevelopment webhook secret without disclosing cell URLs",
    () =>
      Effect.gen(function* () {
        const base = {
          CONTROL_PLANE_DATABASE_URL: "postgres://project:project@localhost/postgres",
          AUTH_SECRET: "a-local-test-signing-secret-long-enough",
        }
        for (const invalid of [
          { BILLING_MODE: "stripe" },
          { BILLING_MODE: "stripe", STRIPE_API_KEY: "fake-key-not-used" },
          {
            METER_CELLS:
              '[{"deploymentId":"cell","databaseUrl":"postgres://private-value@localhost/db","unexpected":true},{"databaseUrl":"postgres://private-value@localhost/db"}]',
          },
        ]) {
          const result = yield* loadOptions.pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ ...base, ...invalid }),
            ),
            Effect.exit,
          )
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result))
            expect(Cause.pretty(result.cause)).not.toContain("private-value")
        }
      }),
  )
  it.effect("refuses production with the readable local email outbox", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        loadOptions.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              CONTROL_PLANE_DATABASE_URL: "postgres://localhost/postgres",
              AUTH_SECRET: "a-local-test-signing-secret-long-enough",
              API_PRODUCTION: "true",
            }),
          ),
        ),
      )
      expect(result._tag).toBe("Failure")
    }),
  )
  const production = {
    CONTROL_PLANE_DATABASE_URL: "postgres://localhost/postgres",
    AUTH_SECRET: "a-production-signing-secret-long-enough",
    API_PRODUCTION: "true",
    EMAIL_MODE: "resend",
    RESEND_API_KEY: "re_config_test_key_never_used",
    API_ORIGIN: "https://api.akter.dev",
    CONSOLE_ORIGIN: "https://app.akter.dev",
    BILLING_MODE: "stripe",
    STRIPE_API_KEY: "local-configuration-test-key-never-used",
    STRIPE_WEBHOOK_SECRET: "local-configuration-test-webhook-never-used",
  }
  const loadProduction = (overrides: Record<string, string>) =>
    Effect.exit(
      loadOptions.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ ...production, ...overrides }),
        ),
      ),
    )
  it.effect("requires a Resend API key whenever email goes through Resend", () =>
    Effect.gen(function* () {
      const { RESEND_API_KEY: _omitted, ...withoutKey } = production
      const result = yield* Effect.exit(
        loadOptions.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown(withoutKey),
          ),
        ),
      )
      expect(result._tag).toBe("Failure")
      const options = yield* loadProduction({})
      expect(Exit.isSuccess(options) && Redacted.value(options.value.resendApiKey!)).toBe(
        "re_config_test_key_never_used",
      )
      expect(Exit.isSuccess(options) && options.value.emailFrom).toBe("Akter <auth@akter.dev>")
    }),
  )
  it.effect("refuses the retired SES email mode", () =>
    Effect.gen(function* () {
      expect((yield* loadProduction({ EMAIL_MODE: "ses" }))._tag).toBe("Failure")
    }),
  )
  it.effect(
    "keeps auth cookies SameSite=Lax unless the stage asks for none, and refuses any other value",
    () =>
      Effect.gen(function* () {
        const sameSite = (overrides: Record<string, string>) =>
          loadProduction(overrides).pipe(
            Effect.map((loaded) =>
              Exit.isSuccess(loaded) ? loaded.value.cookieSameSite : "refused",
            ),
          )
        expect(yield* sameSite({})).toBe("lax")
        expect(yield* sameSite({ AUTH_COOKIE_SAME_SITE: "lax" })).toBe("lax")
        expect(yield* sameSite({ AUTH_COOKIE_SAME_SITE: "none" })).toBe("none")
        for (const value of ["strict", "None", "NONE", "true"])
          expect(yield* sameSite({ AUTH_COOKIE_SAME_SITE: value })).toBe("refused")
      }),
  )
  const fly = JSON.stringify({
    organization: "rika-labs-prod",
    regions: { "us-east-1": { region: "iad" } },
    port: 8080,
    appPrefix: "akter-prod-run-",
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 512 },
  })
  it.effect("reads the Fly runner configuration together with its token", () =>
    Effect.gen(function* () {
      const loaded = yield* loadProduction({
        RUNNER_FLY_CONFIG: fly,
        FLY_API_TOKEN: "fly-config-test-token-never-used",
      })
      if (!Exit.isSuccess(loaded)) return expect(Exit.isSuccess(loaded)).toBe(true)
      expect(loaded.value.runnerFly?.options).toEqual({
        organization: "rika-labs-prod",
        regions: { "us-east-1": { region: "iad" } },
        port: 8080,
        appPrefix: "akter-prod-run-",
        guest: { cpuKind: "shared", cpus: 1, memoryMb: 512 },
      })
      expect(Redacted.value(loaded.value.runnerFly!.token)).toBe("fly-config-test-token-never-used")
    }),
  )
  it.effect(
    "refuses a Fly runner configuration with no token or that Fly could not name apps from",
    () =>
      Effect.gen(function* () {
        const token = { FLY_API_TOKEN: "fly-config-test-token-never-used" }
        const refused: ReadonlyArray<Record<string, string>> = [
          { RUNNER_FLY_CONFIG: fly },
          { RUNNER_FLY_CONFIG: "not json", ...token },
          {
            RUNNER_FLY_CONFIG: fly.replace("akter-prod-run-", "akter-production-environment-run-"),
            ...token,
          },
          { RUNNER_FLY_CONFIG: fly.replace('"iad"', '"Ashburn"'), ...token },
          { RUNNER_FLY_CONFIG: fly.replace('"memoryMb":512', '"memoryMb":64'), ...token },
          { RUNNER_FLY_CONFIG: fly.replace('"organization":"rika-labs-prod",', ""), ...token },
        ]
        for (const overrides of refused)
          expect((yield* loadProduction(overrides))._tag).toBe("Failure")
        const failure = yield* Effect.exit(
          loadOptions.pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({
                ...production,
                RUNNER_FLY_CONFIG: "not json",
                ...token,
              }),
            ),
          ),
        )
        expect(Exit.isFailure(failure) && Cause.pretty(failure.cause)).not.toContain(
          "fly-config-test",
        )
      }),
  )
  it.effect("accepts production with explicit public https origins", () =>
    Effect.gen(function* () {
      expect((yield* loadProduction({}))._tag).toBe("Success")
    }),
  )
  it.effect("leaves the console origin unset so email links fall back to the API origin", () =>
    Effect.gen(function* () {
      const { CONSOLE_ORIGIN: _omitted, ...withoutConsole } = production
      const options = yield* loadOptions.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown(withoutConsole),
        ),
      )
      expect(options.consoleOrigin).toBeUndefined()
      expect(options.origin).toBe("https://api.akter.dev")
    }),
  )
  it.effect("refuses production origins that are not public https", () =>
    Effect.gen(function* () {
      const refused: ReadonlyArray<Record<string, string>> = [
        { API_ORIGIN: "http://api.akter.dev" },
        { CONSOLE_ORIGIN: "https://localhost:5173" },
        { AUTH_TRUSTED_IDP_ORIGINS: "https://idp.example,http://idp.example" },
      ]
      for (const overrides of refused)
        expect((yield* loadProduction(overrides))._tag).toBe("Failure")
    }),
  )
  it.effect("refuses production with the published development secret", () =>
    Effect.gen(function* () {
      const result = yield* loadProduction({
        AUTH_SECRET: "local-development-only-change-before-production",
      })
      expect(result._tag).toBe("Failure")
    }),
  )
  it.effect("refuses a shared runner environment in production", () =>
    Effect.gen(function* () {
      const result = yield* loadProduction({
        RUNNER_ENVIRONMENT: '{"DATABASE_URL":"postgres://shared"}',
      })
      expect(result._tag).toBe("Failure")
    }),
  )
  it.effect(
    "builds images locally only when a build context is named, and never in production",
    () =>
      Effect.gen(function* () {
        const local = {
          CONTROL_PLANE_DATABASE_URL: "postgres://project:project@localhost/postgres",
          AUTH_SECRET: "a-local-test-signing-secret-long-enough",
        }
        const load = (overrides: Record<string, string>) =>
          loadOptions.pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ ...local, ...overrides }),
            ),
          )
        expect((yield* load({})).localBuild).toBeUndefined()
        expect(
          (yield* load({
            RUNNER_BUILD_CONTEXT: "/workspace",
            RUNNER_BUILD_DOCKERFILE: "infra/local/runner/Dockerfile",
          })).localBuild,
        ).toEqual({ context: "/workspace", dockerfile: "infra/local/runner/Dockerfile" })
        expect((yield* load({ RUNNER_BUILD_CONTEXT: "/src" })).localBuild).toEqual({
          context: "/src",
          dockerfile: "Dockerfile",
        })
        expect((yield* loadProduction({ RUNNER_BUILD_CONTEXT: "/workspace" }))._tag).toBe("Failure")
      }),
  )
})
