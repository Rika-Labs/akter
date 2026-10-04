import { ConfigProvider, Effect, Redacted } from "effect"
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
  it.effect("loads local settings without requiring OAuth or AWS credentials", () =>
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
      expect(options.github).toBeUndefined()
      expect(Redacted.value(options.databaseUrl)).toBe(
        "postgres://project:project@localhost/postgres",
      )
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
    EMAIL_MODE: "ses",
    API_ORIGIN: "https://api.akter.dev",
    CONSOLE_ORIGIN: "https://app.akter.dev",
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
})
