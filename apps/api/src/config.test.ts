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
})
