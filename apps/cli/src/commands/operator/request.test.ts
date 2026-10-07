import { ConfigProvider, Effect } from "effect"
import { expect, it } from "vitest"
import { TOKEN_ENV, operatorToken } from "./request.ts"

it("reads the Akter operator token, ignores the old default, and honors an explicitly named variable", () =>
  Effect.gen(function* () {
    const env = {
      AKTER_OPERATOR_TOKEN: "new-token",
      DURABLE_OPERATOR_TOKEN: "old-token",
      CUSTOM_TOKEN: "custom-token",
    }
    expect(TOKEN_ENV).toBe("AKTER_OPERATOR_TOKEN")
    expect(
      yield* operatorToken(TOKEN_ENV).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
      ),
    ).toBe("new-token")
    expect(
      yield* operatorToken(TOKEN_ENV).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: { DURABLE_OPERATOR_TOKEN: "old-token" } }),
        ),
      ),
    ).toBeUndefined()
    expect(
      yield* operatorToken("CUSTOM_TOKEN").pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
      ),
    ).toBe("custom-token")
    expect(
      yield* operatorToken("MISSING_TOKEN").pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
      ),
    ).toBeUndefined()
  }).pipe(Effect.runPromise))
